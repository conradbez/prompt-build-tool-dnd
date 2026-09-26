"""
Simple, stateless FastAPI server for the Workflowy mind map.

One meaningful endpoint — ``POST /run`` — receives the bullet graph as JSON and
returns each bullet's result after flowing through prompt-build-tool (pbt).
No sessions, no file storage, no database: every request is self-contained.

Each bullet becomes a pbt model. A bullet's `@` references become pbt
`{{ ref('...') }}` dependencies, so an upstream bullet's output flows into the
bullets that reference it — pbt resolves the order and runs independent
branches in parallel.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Keys (providers, the S3 bucket, Modal) live in the repo-root `.env`. Loaded
# before anything reads os.environ, and before `modal_exec` checks for tokens.
load_dotenv(pathlib.Path(__file__).resolve().parent.parent / ".env")

import pbt

import export as exporter
import files as attachments
import agent_exec  # registers `model_type="agent_modal"` with pbt on import
import modal_exec  # registers `model_type="python_modal"` with pbt on import
from llm import make_llm_call

# The built frontend (repo-root `dist/`), if it was shipped alongside the
# server. When present it is served at `/`, so one deployment hosts both the
# app and the API and same-origin `/run` works with no configuration.
DIST_DIR = pathlib.Path(__file__).resolve().parent.parent / "dist"

PROVIDERS = {"gemini", "openai", "anthropic"}

# Attachments are held in memory on the way through, so keep them modest.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# pbt has no model_type semantics of its own: it parses this directive into
# `model.config` and passes it to `llm_call(config=...)`, which is where the
# passthrough happens (see `llm.py`). Prepended to a template node's source.
# `global_instruction=False` because a template bullet is a passthrough: its
# rendered prompt *is* its output, so a prepended instruction would show up as
# text in the result instead of steering a model.
TEMPLATE_CONFIG_LINE = '{{ config(model_type="template", global_instruction=False) }}'

# JSON enforcement, also pbt's own: it parses the answer (stripping ```json
# fences), fails the model if it will not parse, and hands the *parsed* value
# downstream. Several `config()` calls in one source merge, so this sits on its
# own line alongside whichever others a bullet needs.
JSON_CONFIG_LINE = '{{ config(output_format="json") }}'

# Validation alone does not make a model comply, so a prompt bullet held to JSON
# is also told to return it. Appended to the bullet's own text, where it is
# visible in the "Model input" column rather than slipped in behind the scenes,
# and it doubles as OpenAI's requirement that a JSON-mode prompt say "JSON".
JSON_INSTRUCTION = "Respond with JSON only — no prose, no code fences."

# A test bullet is a judge, not a step in the pipeline: its text is an
# assertion about what feeds it, and the model is asked for a verdict rather
# than an answer. Held to JSON so the verdict can be read without guessing, and
# kept clear of the global instruction, which is written to steer the work being
# tested rather than the check on it.
TEST_CONFIG_LINE = '{{ config(output_format="json", global_instruction=False) }}'
TEST_INSTRUCTION = (
    "You are checking a test. Decide whether the assertion above holds for the "
    "material below it. Respond with JSON only — no prose, no code fences: "
    '{"pass": true or false, "reason": "one sentence saying why"}.'
)
TEST_MATERIAL = "Material under test:"

# A classifier-judged test skips the LLM: a classifier (TypeSafe's Jev, or a
# local Ollaya) answers the assertion as a yes/no question with P(yes). pbt's
# own classifier-test shape — question above a `---` line, material below — is
# used here too, and `llm.py` routes `judge="classifier"` to the classifier.
CLASSIFIER_SEPARATOR = "---"


# Both keys are read by `llm.py`, not pbt — registered so pbt does not warn.
pbt.register_config_keys("judge", "threshold")


def _classifier_config_line(threshold: float) -> str:
    return '{{ config(judge="classifier", threshold="%s", global_instruction=False) }}' % threshold

# What the "Model input" column says for a bullet that never ran.
SKIPPED_NOTE = (
    "[Not sent. Something this bullet depends on failed, so pbt skipped it — "
    "which is why the inputs below are missing: they were never produced.]"
)


# Attachments reach the model the same way: pbt parses the declared names out
# of the config block and hands the matching files to `llm_call(files=...)`.
def _promptfiles_line(keys: list[str]) -> str:
    return "{{ config(promptfiles='%s') }}" % json.dumps(keys)


# An `@` mention of another bullet, as the editor stores it. It arrives raw
# rather than expanded, because *where it sits* is the point: it marks the place
# in the sentence that the referenced bullet's output belongs.
_MENTION = re.compile(r"@\[\[([A-Za-z0-9_-]+)\]\]")


def _inline(text: str, replace) -> tuple[str, set[str]]:
    """Substitute every mention in *text*, and report which ids were used.

    A mention of a bullet that is not in the run resolves to nothing: it names
    something that produced no output, and leaving a marker for it would be a
    reference to material that is not there.
    """
    used: set[str] = set()

    def sub(match: "re.Match[str]") -> str:
        value = replace(match.group(1))
        if value is None:
            return ""
        used.add(match.group(1))
        return value

    return _MENTION.sub(sub, text), used


def _test_assertion(text: str) -> str:
    """A test's assertion with its mentions taken out: they say what it checks,
    and that material follows the assertion rather than standing inside it."""
    return re.sub(r"[ \t]{2,}", " ", _inline(text, lambda _id: "")[0]).strip()


# A run variable, written in a bullet as `@name`. The `@` has to start a word —
# the same rule the editor's autocomplete uses — so an email address in a prompt
# is not mistaken for one.
_VAR_REF = re.compile(r"(?<![^\s([{])@([A-Za-z0-9_]+)")
# What a variable may be called. Anything else is dropped rather than written
# into a template, since the name goes straight into a Jinja call.
_VAR_NAME = re.compile(r"^[A-Za-z0-9_]+$")


def _clean_promptdata(promptdata: dict[str, str]) -> dict[str, str]:
    """The variables worth passing on: usable names, values as strings.

    The standard coding instructions are written here when they are left empty,
    because only the server knows which packages *this* sandbox has — so the
    default cannot drift from what it describes. A value typed into that row is
    a deliberate override and is passed through untouched.
    """
    clean = {k: str(v) for k, v in promptdata.items() if _VAR_NAME.match(k)}
    if not clean.get(modal_exec.INSTRUCTIONS_VAR, "").strip():
        clean[modal_exec.INSTRUCTIONS_VAR] = modal_exec.standard_instructions()
    return clean


def _as_promptdata(text: str, names: set[str]) -> str:
    """Rewrite each `@name` that names a known variable into pbt's own call.

    Only known names are rewritten: an `@word` matching no variable is text the
    person wrote, and it goes to the model as they wrote it.
    """
    if not names:
        return text
    return _VAR_REF.sub(
        lambda m: '{{ promptdata("%s") }}' % m.group(1) if m.group(1) in names else m.group(0),
        text,
    )


def _fill_vars(text: str, promptdata: dict[str, str]) -> str:
    """The same rewrite, but substituting the values — for showing a person
    what a bullet was actually sent, where a Jinja call would say nothing."""
    if not promptdata:
        return text
    return _VAR_REF.sub(
        lambda m: promptdata.get(m.group(1), m.group(0)),
        text,
    )


class FileRef(BaseModel):
    """An attachment on a bullet: the object key plus its original name."""

    key: str
    name: str = ""


class FileRequest(BaseModel):
    """A request about one stored file, from the session that owns it."""

    key: str
    name: str = ""
    sessionId: str = ""


class Node(BaseModel):
    id: str
    # One markdown text field per bullet; `@` mentions arrive already expanded.
    text: str = ""
    files: list[FileRef] = []
    parentId: Optional[str] = None
    refs: list[str] = []
    # "prompt" | "template" | "python" | "agent" | "test" — see `_build_source`.
    # Else treated as a prompt rather than rejected: a bullet is not worth a 422.
    kind: str = "prompt"
    # An agent bullet's MCP server: the command that starts it over stdio, e.g.
    # `uvx some-mcp-server`. Empty means the agent has bash alone.
    mcpServer: str = ""
    # A python bullet's extra sandbox packages, comma-separated — see
    # `modal_exec.config_line`. Ignored on every other kind.
    packages: str = ""
    # Hold this bullet's answer to JSON — pbt's `output_format="json"`.
    jsonOutput: bool = False
    # A test bullet's judge: "llm" asks the run's model for a verdict,
    # "classifier" asks the classifier for P(yes) and passes at `threshold`.
    judge: str = "llm"
    threshold: float = 0.5


class ClassifierSettings(BaseModel):
    """Settings → classifier: any `/v1/systemone` endpoint (see
    `pbt.systemone_classifier`). Empty fields take pbt's defaults — hosted Jev."""

    apiKey: str = ""
    baseUrl: str = ""
    model: str = ""


class RunRequest(BaseModel):
    nodes: list[Node]
    provider: str = "gemini"
    apiKey: Optional[str] = None
    # Files are namespaced per browser session; see `files.py`.
    sessionId: str = ""
    # Settings → "global instruction": prompt text pbt renders into every
    # bullet's prompt (templates and python bullets opt out). Empty means none.
    globalInstruction: str = ""
    # Settings → run variables, name → value. A bullet writes `@name`; pbt is
    # handed the map and renders `{{ promptdata("name") }}` from it.
    promptdata: dict[str, str] = {}
    classifier: ClassifierSettings = ClassifierSettings()


class ExportRequest(BaseModel):
    """A graph on its way *out* of the app, as a pbt project you can run."""

    # "script" — one file that runs the pipeline; "project" — one file that
    # writes the models/ + client.py layout `pbt serve` expects.
    target: str = "script"
    name: str = "mindmap"
    nodes: list[Node] = []
    provider: str = "gemini"
    globalInstruction: str = ""
    promptdata: dict[str, str] = {}
    # Only used to keep an attachment's `promptfiles` line honest — the bytes
    # themselves never leave the bucket, and the export says so.
    sessionId: str = ""


class ExportResponse(BaseModel):
    filename: str = ""
    text: str = ""
    # What could not come along — attachments, custom model kinds. Shown to the
    # person rather than left for them to discover when the export fails.
    warnings: list[str] = []
    errors: list[str] = []


class RunResponse(BaseModel):
    # Set when the run stopped before it started because there is no key for
    # the chosen provider — neither sent from the UI nor set on the server. The
    # UI points at its settings rather than printing a failure per bullet.
    needsKey: bool = False
    # Keyed by the bullet id the client sent, so the UI can map results back.
    outputs: dict[str, str] = {}
    # The prompt each bullet was actually sent, same keys. The UI shows it
    # beside the answer, so "why did it say that" has an answer on screen.
    prompts: dict[str, str] = {}
    # Each test bullet's verdict: "pass", "fail", or "skipped" when something
    # it checks failed and it never ran. A test absent here has not run.
    tests: dict[str, str] = {}
    errors: list[str] = []


def _has_key(provider: str, api_key: Optional[str]) -> bool:
    """Whether the UI sent a key — the only place `llm.py` looks, checked before
    the graph is built so "no key" is one answer rather than an error on every
    bullet."""
    return bool(api_key)


def _slug(node_id: str) -> str:
    """A pbt-safe model name derived from a bullet id (used in ref() too)."""
    return "n_" + re.sub(r"[^0-9a-zA-Z]", "_", node_id)


def _build_source(
    node: Node,
    child_ids: list[str],
    id_to_slug: dict[str, str],
    session_id: str = "",
    var_names: set[str] | None = None,
) -> str:
    """Compose a bullet's pbt prompt.

    An `@` reference is substituted **where it stands**: the mention marks the
    place in the sentence that the referenced bullet's answer belongs, so it
    becomes that bullet's `{{ ref('...') }}` and the answer is rendered inline.
    Nothing about the reference is spelled out — the name was only ever a
    placeholder for its content.

    Everything else follows the bullet's text: a node's **children are
    auto-included** (their outputs feed up into the parent) in child order, then
    any `@` reference that had no place of its own to go. So a bullet reads as
    its instruction followed by the material that instruction is about, and
    "summarise what follows" means what it says.

    A template node additionally gets a `{{ config(model_type="template") }}`
    line, which pbt parses into `model.config` and hands to `llm_call`, where
    it short-circuits into a passthrough instead of an LLM call.

    A python node gets the `python_modal` config line instead, and its refs go
    into a Jinja *comment* — see `_python_source`. An agent node keeps the
    ordinary shape — its rendered text is the agent's task — plus the `agent_modal` config line naming its MCP server, if
    any (see `agent_exec.py`).

    Any `@name` naming a run variable becomes `{{ promptdata("name") }}` on the
    way through, which is how the values reach the prompt (see `_as_promptdata`).
    """
    dep_ids = _deps(node, child_ids, id_to_slug)
    dep_slugs = [id_to_slug[d] for d in dep_ids]
    if node.kind == "python":
        return _python_source(node, dep_slugs, node.packages)

    if node.kind == "test":
        # The assertion, then the verdict it wants, then what it is about. A
        # mention only connects the test; it is not inlined, or the material
        # would land inside the assertion and leave "Material under test" empty.
        text = _test_assertion(_as_promptdata(node.text.strip(), var_names or set()))
        ref_lines = ["{{ ref('%s') }}" % id_to_slug[d] for d in dep_ids]
        if _is_classifier(node):
            return "\n".join(
                [_classifier_config_line(_threshold(node)), text, CLASSIFIER_SEPARATOR, *ref_lines]
            )
        return "\n".join([TEST_CONFIG_LINE, text, TEST_INSTRUCTION, TEST_MATERIAL, *ref_lines])
    text, inlined = _inline(
        _as_promptdata(node.text.strip(), var_names or set()),
        lambda ref_id: "{{ ref('%s') }}" % id_to_slug[ref_id] if ref_id in id_to_slug else None,
    )
    prompt = _json_body(node, text)
    # Only what has nowhere else to be: a reference already standing in the
    # sentence must not also be pasted underneath it.
    ref_lines = ["{{ ref('%s') }}" % id_to_slug[d] for d in dep_ids if d not in inlined]
    source = "\n".join([prompt, *ref_lines]) if ref_lines else prompt
    if node.jsonOutput:
        source = JSON_CONFIG_LINE + "\n" + source
    if node.kind == "template":
        source = TEMPLATE_CONFIG_LINE + "\n" + source
    if node.kind == "agent":
        # The sandbox never sees attachments, so none are declared either.
        return agent_exec.config_line(node.mcpServer) + "\n" + source
    keys = _node_file_keys(node, session_id)
    if keys:
        source = _promptfiles_line(keys) + "\n" + source
    return source


def _children(nodes: list[Node]) -> dict[str, list[str]]:
    """Parent id → child ids, from each bullet's `parentId`. Children feed their parent."""
    children: dict[str, list[str]] = {n.id: [] for n in nodes}
    for n in nodes:
        if n.parentId in children:
            children[n.parentId].append(n.id)
    return children


def _models(
    nodes: list[Node],
    children: dict[str, list[str]],
    names: dict[str, str],
    session_id: str,
    promptdata: dict[str, str],
) -> dict[str, str]:
    """Every bullet's pbt source, keyed by its model name — for a run and an
    export alike."""
    feeds = _feeding(nodes, names)
    return {
        names[n.id]: _build_source(n, children[n.id], feeds, session_id, set(promptdata))
        for n in nodes
    }


def _feeding(nodes: list[Node], names: dict[str, str]) -> dict[str, str]:
    """The model names a bullet may depend on: every bullet but a test.

    A test's output is a verdict on other bullets, not material for one, so it
    never flows onward — not as a child into its parent, not through an `@`. A
    test hung under a bullet checks it from the side rather than feeding it.
    """
    tests = {n.id for n in nodes if n.kind == "test"}
    return {k: v for k, v in names.items() if k not in tests}


def _is_classifier(node: Node) -> bool:
    return node.kind == "test" and node.judge == "classifier"


def _threshold(node: Node) -> float:
    """The pass mark for a classifier test, clamped to what pbt accepts."""
    return min(1.0, max(0.0, node.threshold))


def _json_body(node: Node, text: str) -> str:
    """A JSON bullet's text, with the instruction that goes with the rule.

    Only a *prompt* or an agent's task asks a model for anything: a template's
    rendered text is its own output, so an instruction appended to one would
    come out in the answer, and a python bullet's text never runs at all. Both
    still carry the config line — the validation applies to whatever they
    produce.
    """
    if not node.jsonOutput or node.kind not in ("prompt", "agent"):
        return text
    return "\n".join([text, JSON_INSTRUCTION]) if text else JSON_INSTRUCTION


def _deps(node: Node, child_ids: list[str], id_to_slug: dict[str, str]) -> list[str]:
    """What feeds this bullet, in the order it arrives: children, then `@` refs.

    A child is not repeated if it is also referenced explicitly.
    """
    dep_ids: list[str] = []
    for c in child_ids:
        if c in id_to_slug:
            dep_ids.append(c)
    for r in node.refs:
        if r in id_to_slug and r not in dep_ids:
            dep_ids.append(r)
    return dep_ids


def _python_source(node: Node, dep_slugs: list[str], packages: str = "") -> str:
    """A python bullet's source: its dependency, and nothing else.

    A python bullet holds no code of its own — it runs what its one child
    produced. So its own text never reaches the sandbox, and this source
    carries only the two directives pbt needs.

    The refs go inside a Jinja *comment* rather than on their own lines the way
    a prompt bullet's do. `extract_dependencies` scans the raw source with a
    regex, so the ordering and the parallelism still come out right, while the
    comment renders to nothing — leaving no upstream text pasted into what is
    about to be compiled as Python. The outputs reach the sandbox as `inputs`,
    injected by the `python_modal` model kind in dependency order (see
    `modal_exec.py`).

    Attachments are deliberately not declared here: the sandbox is a different
    machine and never sees them, so there is nothing to fetch from the bucket.

    The bullet's own packages (set in its settings) ride along in the config
    line — see `modal_exec.config_line`.
    """
    lines = [modal_exec.config_line(packages)]
    if dep_slugs:
        refs = " ".join("ref('%s')" % slug for slug in dep_slugs)
        lines.append("{# inputs in order: %s #}" % refs)
    return "\n".join(lines)


def _runnable(nodes: list[Node]) -> list[Node]:
    """The bullets worth running: everything except wholly empty subtrees.

    An empty bullet is not necessarily a blank one — it is how you write "hand
    my children's outputs upward", and dropping it used to cut the branch below
    it out of the graph silently, since a child reaches the root only through
    its parent. So a bullet is kept when it has text *or* anything beneath it
    does; only a subtree that is empty all the way down is skipped.
    """
    by_id = {n.id: n for n in nodes}
    children: dict[str, list[str]] = {n.id: [] for n in nodes}
    for n in nodes:
        if n.parentId in children:
            children[n.parentId].append(n.id)

    filled: set[str] = set()

    def fills(node_id: str, seen: frozenset[str]) -> bool:
        """True if this bullet or any descendant has text. Cycle-safe."""
        if node_id in filled:
            return True
        if node_id in seen:  # a malformed parentId loop shouldn't hang the run
            return False
        below = seen | {node_id}
        node = by_id[node_id]
        # A python bullet's own text never runs, so it cannot be what makes a
        # branch worth running — only the children it would execute can.
        own = bool(node.text.strip()) and node.kind != "python"
        if own or any(fills(c, below) for c in children[node_id]):
            filled.add(node_id)
            return True
        return False

    return [n for n in nodes if fills(n.id, frozenset())]


def _overfull_python(nodes: list[Node]) -> list[str]:
    """Ids of python bullets fed by more than one upstream bullet.

    A python bullet's child output *is* its program, so a second input would
    mean two scripts concatenated into one file. One child, one program. `@`
    references count too — they reach the sandbox by the same route, and the
    editor cannot produce one on a python bullet, so anything arriving here
    with them came from elsewhere.
    """
    known = {n.id for n in nodes}
    counts: dict[str, int] = {}
    for n in nodes:
        if n.parentId in known:
            counts[n.parentId] = counts.get(n.parentId, 0) + 1
    return [
        n.id
        for n in nodes
        if n.kind == "python"
        and counts.get(n.id, 0) + len([r for r in n.refs if r in known]) > 1
    ]


def _model_input(
    node: Node,
    dep_ids: list[str],
    results: dict[str, str],
    global_instruction: str = "",
    promptdata: dict[str, str] | None = None,
) -> str:
    """The prompt as the model received it, rebuilt from the run's outputs.

    pbt renders `{{ ref('x') }}` into x's output, so the prompt a bullet was
    actually sent is its own text followed by each dependency's result, in
    dependency order — the same assembly `_build_source` describes. Rebuilt
    here rather than fished out of pbt: `async_run` hands back outputs only,
    and a cached node never re-renders, so there is nothing to fish.

    A python bullet is the exception: its own text is not part of the program,
    and what runs is the code extracted from its child.

    The global instruction sits on top, the way pbt prepends it — but only for
    the bullets that receive one, i.e. prompts. Templates and python bullets
    opt out, so showing it there would be a lie about what ran. (pbt treats an
    instruction containing `{{ prompt }}` as a wrapper instead; this rebuild
    shows the plain prepend, which is what the settings box invites.)
    """
    if node.kind == "python":
        return modal_exec._inherited_code([results[d] for d in dep_ids if d in results])
    if node.kind == "test":
        text = _test_assertion(_fill_vars(node.text.strip(), promptdata or {}))
        parts = [results[d] for d in dep_ids if d in results]
        if _is_classifier(node):
            return "\n".join([text, CLASSIFIER_SEPARATOR, *parts])
        return "\n".join([text, TEST_INSTRUCTION, TEST_MATERIAL, *parts])
    # Variables are shown filled in, not as the Jinja call they were compiled
    # to, and a reference is shown as the answer that replaced it — this column
    # exists to answer "what did the model actually see".
    text, inlined = _inline(
        _fill_vars(node.text.strip(), promptdata or {}),
        lambda ref_id: results.get(ref_id),
    )
    own = _json_body(node, text)
    parts = [results[d] for d in dep_ids if d in results and d not in inlined]
    body = "\n".join([own, *parts]) if parts else own
    if global_instruction and node.kind != "template":
        return _fill_vars(global_instruction, promptdata or {}).rstrip("\n") + "\n\n" + body
    return body


def _json_forms(text: str) -> tuple[str, str]:
    """A JSON answer's two forms: ``(what a person reads, what pbt rendered)``.

    `output_format="json"` makes pbt hand the *parsed* value downstream, and
    Jinja writes a parsed value into the next prompt with `str()` — a
    Python-style mapping, single quotes and all. So the answer panel and the
    "Model input" column genuinely differ here, and pretending otherwise would
    make the column say something that never reached a model.
    """
    try:
        value = json.loads(text)
    except ValueError:
        return text, text  # not parseable here means it was never parsed there
    return json.dumps(value, indent=2, ensure_ascii=False), str(value)


def _verdict(output: str) -> str:
    """A test's answer as "pass" or "fail". Anything but an explicit pass fails:
    a check that cannot say it passed has not passed."""
    try:
        value = json.loads(output)
    except ValueError:
        return "fail"
    if isinstance(value, dict):
        value = value.get("pass")
    return "pass" if value is True or str(value).strip().lower() in ("true", "pass") else "fail"


def _node_file_keys(node: Node, session_id: str) -> list[str]:
    """The attachments this bullet may use — its own, and nothing else.

    Two gates: the key must sit under the *session* that sent the request, and
    under *this bullet* within it. pbt's promptfiles are a flat namespace, so a
    node naming someone else's key is ignored rather than trusted.
    """
    return [f.key for f in node.files if attachments.belongs_to(f.key, session_id, node.id)]


def _title(node: Node) -> str:
    """What to call a bullet in a message to a person: its first line.

    Errors used to name the pbt model — `n_gT4b9…`, a slug built from an id
    nobody has seen — which is the right name for the run and the wrong one for
    the sentence a person reads when it fails.
    """
    line = node.text.split("\n", 1)[0].strip() if node.text else ""
    line = re.sub(r"^\s*(#{1,6}\s+|[-*+]\s+|>\s+)", "", line)
    if node.kind == "python" and not line:
        return "the python bullet"
    return f"“{line[:40]}…”" if len(line) > 40 else f"“{line}”" if line else "an empty bullet"


def _serialise(
    outputs: dict[str, Any], titles: dict[str, str] | None = None
) -> tuple[dict[str, str], list[str], set[str]]:
    """Split pbt outputs into results, error strings, and the names it skipped.

    A skip is not an error of its own: it is what happens *to* a bullet when
    something it depends on fails. Kept apart from the errors so the run can say
    which bullets never went anywhere, rather than leaving a prompt on screen
    that was never sent.
    """
    titles = titles or {}
    results: dict[str, str] = {}
    errors: list[str] = []
    skipped: set[str] = set()
    for name, value in outputs.items():
        label = titles.get(name, name)
        if isinstance(value, pbt.ModelError):
            errors.append(f"{label}: {value.message}")
        elif isinstance(value, pbt.ModelStatus):
            skipped.add(name)
            errors.append(f"{label}: skipped — something it needs did not run.")
        else:
            text = value if isinstance(value, str) else str(value)
            # Stripped because a template bullet's output is its own rendered
            # source, and the injected `{{ config(...) }}` line renders to an
            # empty first line.
            results[name] = text.strip()
    return results, errors, skipped


app = FastAPI(title="Workflowy mind-map runner", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def health() -> dict:
    """Lightweight health check."""
    return {"status": "ok", "pbt_version": pbt.__version__}


@app.get("/files/enabled")
def files_enabled() -> dict:
    """Whether a bucket is configured — the UI hides attaching if not."""
    return {"enabled": attachments.enabled()}


@app.get("/python/enabled")
def python_enabled() -> dict:
    """Whether Modal is configured, and what its sandbox has installed.

    The packages are chosen on the server (see `modal_exec`), but the prompt
    that writes the script is written in the browser — so the browser has to be
    able to say what is available, or a person is guessing at the one thing
    their script may not do without.
    """
    return {
        "enabled": modal_exec.enabled(),
        "packages": modal_exec.packages(),
        "rejected": modal_exec.rejected(),
    }


@app.get("/agent/enabled")
def agent_enabled() -> dict:
    """Whether agent bullets can run here — they need Modal, as python does."""
    return {"enabled": agent_exec.enabled(), "rejected": agent_exec.rejected()}


@app.post("/files")
async def upload(
    sessionId: str = Form(...),
    bulletId: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    """Attach one file to one bullet, inside the caller's session."""
    if not attachments.enabled():
        return {"error": "File storage is not configured on this server."}
    if not sessionId:
        return {"error": "Missing session."}
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return {"error": f"That file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."}
    try:
        return attachments.put(sessionId, bulletId, file.filename or "file", data)
    except Exception as exc:  # noqa: BLE001 — surface storage errors to the UI
        return {"error": str(exc)}


@app.post("/files/link")
def link(req: FileRequest) -> dict:
    """A short-lived download URL for one of *this session's* files.

    The bytes travel from the bucket to the browser directly; the server only
    signs, and only for keys under the session that asked.
    """
    if not attachments.enabled():
        return {"error": "File storage is not configured on this server."}
    if not attachments.in_session(req.key, req.sessionId):
        return {"error": "That file does not belong to this session."}
    try:
        return {"url": attachments.presign(req.key, req.name), "expiresIn": attachments.LINK_TTL_SECONDS}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


@app.post("/files/delete")
def remove_file(req: FileRequest) -> dict:
    if not attachments.enabled():
        return {"error": "File storage is not configured on this server."}
    if not attachments.in_session(req.key, req.sessionId):
        return {"error": "That file does not belong to this session."}
    try:
        attachments.delete(req.key)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


@app.post("/export", response_model=ExportResponse)
def export(req: ExportRequest) -> ExportResponse:
    """The graph as a pbt project, built from the same sources a run uses.

    Nothing here is stored and nothing runs — this is `_build_source` over the
    same graph, named for reading rather than for uniqueness, wrapped in a file.
    """
    nodes = _runnable(req.nodes)
    if not nodes:
        return ExportResponse(errors=["Nothing to export — every bullet is empty."])

    promptdata = _clean_promptdata(req.promptdata)
    # Readable names, not `n_<id>`: these become file names and `ref('…')`
    # calls that a person is going to read and edit.
    id_to_name = exporter.model_names(nodes)
    models = _models(nodes, _children(nodes), id_to_name, req.sessionId, promptdata)

    notes = exporter.warnings(nodes)
    build = exporter.project if req.target == "project" else exporter.script
    return ExportResponse(
        filename=exporter.filename(req.name, req.target),
        text=build(
            req.name,
            models,
            req.provider,
            req.globalInstruction.strip(),
            promptdata,
            notes,
        ),
        warnings=notes,
    )


@app.post("/run", response_model=RunResponse)
async def run(req: RunRequest) -> RunResponse:
    if req.provider not in PROVIDERS:
        return RunResponse(errors=[f"Unsupported provider: {req.provider}"])

    if not _has_key(req.provider, req.apiKey):
        return RunResponse(needsKey=True, errors=["Enter an API key to run models."])

    global_instruction = req.globalInstruction.strip()
    # The variables the run may use. `@name`s in the bullets are rewritten
    # against these names, and pbt is handed the values.
    promptdata = _clean_promptdata(req.promptdata)
    var_names = set(promptdata)

    nodes = _runnable(req.nodes)
    if not nodes:
        return RunResponse(errors=["No non-empty bullets to run."])

    # A test connected to nothing has nothing to check, so it is left out of
    # the run rather than asked to judge an empty page — it stays "not run".
    kids = _children(nodes)
    feeders = _feeding(nodes, {n.id: n.id for n in nodes})
    nodes = [n for n in nodes if n.kind != "test" or _deps(n, kids[n.id], feeders)]
    if not nodes:
        return RunResponse(errors=["No non-empty bullets to run."])

    # The editor keeps a python bullet to one child, but the editor is not the
    # only thing that can post here.
    crowded = _overfull_python(nodes)
    if crowded:
        plural = "one bullet has" if len(crowded) == 1 else f"{len(crowded)} bullets have"
        return RunResponse(
            errors=[
                f"A python bullet runs the code from a single child, but "
                f"{plural} more than one input."
            ]
        )

    id_to_slug = {n.id: _slug(n.id) for n in nodes}
    slug_to_id = {v: k for k, v in id_to_slug.items()}

    children = _children(nodes)
    models = _models(nodes, children, id_to_slug, req.sessionId, promptdata)
    feeds = _feeding(nodes, id_to_slug)

    # Pull each bullet's attachments once, keyed the way the config declares
    # them, so pbt can route them to the model that asked.
    promptfiles: dict[str, Any] = {}
    try:
        for n in nodes:
            if n.kind in ("python", "agent", "test"):
                continue  # a sandbox never sees attachments — don't fetch them
            for key in _node_file_keys(n, req.sessionId):
                if key not in promptfiles:
                    promptfiles[key] = attachments.get(key)
    except Exception as exc:  # noqa: BLE001 — a missing object shouldn't 500
        return RunResponse(errors=[f"Could not read an attached file: {exc}"])

    # Agent bullets call the model from inside their sandbox, so they need this
    # run's provider and key too — bound for the tasks pbt spawns, not globally.
    provider_token = agent_exec.use_provider(req.provider, req.apiKey)
    try:
        llm = make_llm_call(
            api_key=req.apiKey, provider=req.provider, classifier=req.classifier.model_dump()
        )
        outputs = await pbt.async_run(
            models_from_dict=models,
            llm_call=llm,
            promptfiles=promptfiles or None,
            promptdata=promptdata or None,
            # `ref()` is refused inside a global instruction — pbt says as much
            # and points at promptdata — but a variable is exactly what belongs
            # there, so `@name` is rewritten here too.
            global_instruction=_as_promptdata(global_instruction, var_names) or None,
            verbose=False,
        )
    except Exception as exc:  # noqa: BLE001 — surface any failure to the client
        return RunResponse(errors=[str(exc)])
    finally:
        agent_exec.reset_provider(provider_token)

    results, errors, skipped_slugs = _serialise(
        outputs, {id_to_slug[n.id]: _title(n) for n in nodes}
    )
    by_id = {slug_to_id.get(name, name): value for name, value in results.items()}
    skipped = {slug_to_id.get(name, name) for name in skipped_slugs}
    # Anything structured reads one way and renders another — see `_json_forms`.
    rendered = dict(by_id)
    for n in nodes:
        if (n.jsonOutput or n.kind in ("agent", "test")) and n.id in by_id:
            by_id[n.id], rendered[n.id] = _json_forms(by_id[n.id])

    prompts = {}
    for n in nodes:
        deps = _deps(n, children[n.id], feeds)
        body = _model_input(n, deps, rendered, global_instruction, promptdata)
        if n.id in skipped:
            # Say so rather than showing a prompt that was never sent: the
            # inputs are missing from it because they never arrived, and a
            # reconstruction that does not admit that reads as a bug in the
            # reference that fed it.
            body = SKIPPED_NOTE + "\n\n" + body
        prompts[n.id] = body
    # A test that ran says pass or fail; one skipped because what it checks
    # failed did not run; one that errored itself could not say it passed.
    tests = {}
    for n in nodes:
        if n.kind != "test":
            continue
        if n.id in skipped:
            tests[n.id] = "skipped"
        else:
            tests[n.id] = _verdict(by_id[n.id]) if n.id in by_id else "fail"
    return RunResponse(outputs=by_id, prompts=prompts, tests=tests, errors=errors)


# Serve the built frontend last, so `/run` and `/healthz` take precedence.
# `html=True` serves index.html at `/`. Absent in dev (no dist/) — skipped.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
