"""
Simple, stateless FastAPI server for Visual Prompt Map.

One meaningful endpoint — ``POST /run`` — receives the bullet graph as JSON and
streams each bullet's progress and result as it flows through
promptmap (formerly prompt-build-tool).
No sessions, no file storage, no database: every request is self-contained.

Each bullet becomes a promptmap model. A bullet's `@` references become promptmap
`{{ ref('...') }}` dependencies, so an upstream bullet's output flows into the
bullets that reference it — promptmap resolves the order and runs independent
branches in parallel.
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import os
import pathlib
import re
from typing import Any, Callable, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Keys (providers, the S3 bucket, Modal) live in the repo-root `.env`. Loaded
# before anything reads os.environ, and before `modal_exec` checks for tokens.
load_dotenv(pathlib.Path(__file__).resolve().parent.parent / ".env")

import promptmap
from promptmap.files import contains_files, iter_files, to_jsonable

import export as exporter
import files as attachments
# promptmap finds these kinds by entry point; imported here for their helpers.
from promptmap_extra_model_kinds import agent37_exec, agent_exec, modal_exec
import accounts
import bug_reports
import search
from llm import make_llm_call
from promptmap_extra_model_kinds.models import model_name
from promptmap import model_types as _promptmap_kinds

# A remote-browser agent is told to drive Chromium with Playwright's
# `connect_over_cdp`, but the agent image has no Playwright — so the agent
# spent its first steps hunting for a CDP client. The wheel bundles its own
# driver and needs no browser download for CDP, so it goes in the image's pip
# extras alongside whatever the deployment set. Read lazily, when the image is
# first built.
_pip_extras = os.environ.get(agent_exec.PIP_ENV, "")
if "playwright" not in _pip_extras.lower():
    os.environ[agent_exec.PIP_ENV] = ", ".join(p for p in (_pip_extras.strip(), "playwright") if p)

# Only the kinds this server asks for stay registered. promptmap and its extras
# also register kinds that run code on *this* machine — `agent` / `coding_agent`
# (bash), `execute_python` (exec() in-process), `agent_multi_harness`,
# `browser_use` — and nothing here wants them: code runs on Modal or Agent37.
# Plugins are loaded first so a later lookup cannot bring one back. A
# `model_type` naming a removed kind then fails the bullet as unknown.
ALLOWED_KINDS = {"", "template", modal_exec.MODEL_TYPE, agent_exec.MODEL_TYPE, agent37_exec.MODEL_TYPE}
_promptmap_kinds.load_plugins()
for _kind_name in list(_promptmap_kinds._REGISTRY):
    if _kind_name not in ALLOWED_KINDS:
        del _promptmap_kinds._REGISTRY[_kind_name]

# Most bullets a run works on at once (promptmap's `max_parallel`). Independent
# bullets — agents included — run side by side, so this caps concurrent spend
# and provider rate limits too. Settings may ask for fewer or more, within MAX.
DEFAULT_PARALLEL = 4
MAX_PARALLEL = 8

# The built frontend (repo-root `dist/`), if it was shipped alongside the
# server. When present it is served at `/`, so one deployment hosts both the
# app and the API and same-origin `/run` works with no configuration.
DIST_DIR = pathlib.Path(__file__).resolve().parent.parent / "dist"

PROVIDERS = {"gemini", "openai", "anthropic", "openrouter"}

# Attachments are held in memory on the way through, so keep them modest.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# promptmap's built-in `template` kind: the rendered prompt *is* the output, no
# LLM call, and no global instruction (the kind opts out of it).
TEMPLATE_CONFIG_LINE = '{{ config(model_type="template") }}'

# A search bullet is a template whose rendered text — refs and variables filled
# in — is captured as the query and swapped for the web results a RAG kind from
# promptmap-extra-model-kinds returns for it. Which one depends on the run's
# provider (see `search.py`): the provider's own grounded search, on the key the
# person sent, or Brave where the provider has none.
SEARCH_OPEN = "{% set query %}"


def _search_close(provider: str) -> str:
    return '{%% endset %%}{{ %s(query) | join("\\n\\n") }}' % search.function_for(provider)

# JSON enforcement, also promptmap's own: it parses the answer (stripping ```json
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

# The same check, exported as a promptmap test (`*.testprompt`) rather than a
# model: promptmap reads the verdict itself, and only as `{"results": "pass"}`.
# No config line — promptmap never gives a test the global instruction, and a
# test's `llm_call` is handed no config to ask for JSON mode with.
NATIVE_TEST_INSTRUCTION = (
    "You are checking a test. Decide whether the assertion above holds for the "
    "material below it. Respond with JSON only — no prose, no code fences: "
    '{"results": "pass" or "fail", "reason": "one sentence saying why"}.'
)

# A classifier-judged test skips the LLM: a classifier (TypeSafe's Jev, or a
# local Ollaya) answers the assertion as a yes/no question with P(yes). promptmap's
# own classifier-test shape — question above a `---` line, material below — is
# used here too, and `llm.py` routes `judge="classifier"` to the classifier.
CLASSIFIER_SEPARATOR = "---"


# Both keys are read by `llm.py`, not promptmap — registered so promptmap does not warn.
promptmap.register_config_keys("judge", "threshold")

# The run variable a person sets in Settings to pick the model they run with.
# promptmap reads `config()` before any promptdata exists, so the server resolves it
# itself: it goes straight to the LLM client and the agent sandbox, and into
# the config of every bullet that calls a model as promptmap's own `model` key
# (the one its default LiteLLM backend reads), where `llm.py` and the agent
# kinds read a bullet's own choice — and where an exported project's backend
# reads it too.
LLM_MODEL_VAR = "llm_model"
MODEL_KEY = "model"
_MODEL_ID = re.compile(r"^[A-Za-z0-9._:/@-]+$")

# The model is left out of promptmap's cache key: switching models keeps the
# answers already run rather than paying for them again. A bullet's kind still
# counts — it is `model_type` in the same config — so changing that reruns it.
# Turn a bullet's cache off for a fresh answer from the new model.
from promptmap.executor import run_context as _run_context

_run_context._NON_KEY_CONFIG = _run_context._NON_KEY_CONFIG | {MODEL_KEY}

# An agent bullet with a public URL ends its answer with the URL in this block,
# which the editor pulls out and shows as a link of its own (`src/AgentLinks.tsx`)
# rather than leaving it to be found somewhere in the prose.
PUBLIC_URL_INSTRUCTION = """

When you have served something on your public URL, end your answer with that
URL alone in this block, exactly:

[public url]
https://…
[/public url]
"""

# A bullet that knows its place: the bullets around it, as promptmap's own
# outline of the graph — the window one step up and down, plus the map's final
# outputs, with "[you are here]" on this one. Model names are the bullets'
# titles (see `exporter.model_names`), so the tree reads as the map does.
OUTLINE_BLOCK = """

Where this sits in the larger map (each bullet is built from the ones nested under it):
{{ org_outline(up=1, down=1, zoom=1) }}"""

# A bullet with caching off: promptmap skips the cache lookup and always runs it.
NO_CACHE_CONFIG_LINE = "{{ config(cache=False) }}"


def _llm_model(promptdata: dict[str, str]) -> str | None:
    """The model this person chose, or None for the server's default."""
    return _model_id(promptdata.get(LLM_MODEL_VAR, ""))


def _model_id(value: str) -> str | None:
    """``value`` if it could be a model id, else None.

    Anything else is ignored rather than trusted: the value is written into a
    Jinja `config()` call.
    """
    value = value.strip()
    return value if _MODEL_ID.match(value) else None


def _with_bullet_model(kind_name: str) -> None:
    """Let an agent kind's bullet name its own model.

    The agent kinds take the model from the run (`agent_exec.RunSettings`), not
    from `config()`, so the bullet's `model` is swapped into the run
    settings for the length of its own call.
    """
    kind = _promptmap_kinds.get_model_kind(kind_name)
    if kind is None or kind.exec_fn is None:
        return
    inner = kind.exec_fn

    async def execute(rendered: str, call: promptmap.ModelCall) -> Any:
        model = call.spec.config.get(MODEL_KEY)
        if not model:
            return await inner(rendered, call)
        run = agent_exec._settings.get()
        token = agent_exec._settings.set(dataclasses.replace(run, model=str(model)))
        try:
            return await inner(rendered, call)
        finally:
            agent_exec._settings.reset(token)

    _promptmap_kinds.register_model_kind(dataclasses.replace(kind, exec_fn=execute))


for _agent_kind in (agent_exec.MODEL_TYPE, agent37_exec.MODEL_TYPE):
    _with_bullet_model(_agent_kind)


def _calls_model(node: Node) -> bool:
    """Whether a bullet's answer comes from the LLM (or an agent driving one)."""
    return node.kind in ("prompt", "agent") or (node.kind == "test" and not _is_classifier(node))


def _classifier_config_line(threshold: float) -> str:
    return '{{ config(judge="classifier", threshold="%s", global_instruction=False) }}' % threshold

# What the "Model input" column says for a bullet that never ran.
SKIPPED_NOTE = (
    "[Not sent. Something this bullet depends on failed, so promptmap skipped it. "
    "Its own text is below; its inputs were never produced.]"
)
# …and for one that failed: promptmap reports no rendered prompt for an error.
FAILED_NOTE = "[This bullet failed — see the error. Its own text is below.]"


# Attachments reach the model the same way: promptmap parses the declared names out
# of the config block and hands the matching files to `llm_call(files=...)`.
def _promptfiles_line(keys: list[str]) -> str:
    return "{{ config(promptfiles='%s') }}" % json.dumps(keys)


# An `@` mention of another bullet, as the editor stores it. It arrives raw
# rather than expanded, because *where it sits* is the point: it marks the place
# in the sentence that the referenced bullet's output belongs.
_MENTION = re.compile(r"@\[\[([A-Za-z0-9_-]+)\]\]")


# The only Jinja a person's text may carry once the server has rewritten it:
# the `ref()` and `promptdata()` calls `_inline` and `_as_promptdata` put in.
# Each takes a bare word, so neither can reach anything else.
_ALLOWED_JINJA = re.compile(r"""\{\{ (?:ref\('\w+'\)|promptdata\("\w+"\)) \}\}""")
# A global instruction may also wrap the prompt with `{{ prompt }}`.
_ALLOWED_GLOBAL_JINJA = re.compile(_ALLOWED_JINJA.pattern + r"|\{\{\s*prompt\s*\}\}")


def _escape_jinja(text: str, allowed: "re.Pattern[str]" = _ALLOWED_JINJA) -> str:
    """*text* as Jinja source that renders back to itself, but for the calls
    *allowed* matches.

    promptmap renders every bullet with plain (unsandboxed) Jinja, so a `{{ … }}` a
    person typed would run on this server, and a `{{ config(…) }}` would
    override the config the server set — the model kind included. Every other
    `{` becomes `{{ '{' }}`, so no tag can start.
    """
    out, at = [], 0
    for match in allowed.finditer(text):
        out.append(text[at:match.start()].replace("{", "{{ '{' }}"))
        out.append(match.group(0))
        at = match.end()
    out.append(text[at:].replace("{", "{{ '{' }}"))
    return "".join(out)


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
    """Rewrite each `@name` that names a known variable into promptmap's own call.

    Only known names are rewritten: an `@word` matching no variable is text the
    person wrote, and it goes to the model as they wrote it.
    """
    if not names:
        return text
    return _VAR_REF.sub(
        lambda m: '{{ promptdata("%s") }}' % m.group(1) if m.group(1) in names else m.group(0),
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
    # The bullet's name — its top line. Not sent to the model: it names the
    # bullet in `@` mentions, run logs, and the exported file.
    title: str = ""
    # The bullet's body, in markdown; `@` mentions arrive already expanded.
    text: str = ""
    files: list[FileRef] = []
    parentId: Optional[str] = None
    refs: list[str] = []
    # "prompt" | "template" | "search" | "python" | "agent" | "test" — see `_build_source`.
    # Else treated as a prompt rather than rejected: a bullet is not worth a 422.
    kind: str = "prompt"
    # An agent bullet's MCP server: the command that starts it over stdio, e.g.
    # `uvx some-mcp-server`. Empty means the agent has bash alone.
    mcpServer: str = ""
    # An agent bullet's step limit; 0 means the run's (`RunRequest.agentSteps`).
    agentSteps: int = 0
    # An agent bullet's wait between model calls, in seconds; 0 for none.
    agentBackoff: float = 0
    # An agent bullet that hands on files, not only text — see `agent_exec`.
    producesFiles: bool = False
    # An agent bullet with a Chromium a person can watch and take over — see `agent_exec`.
    remoteBrowser: bool = False
    # An Agent37 agent bullet with a public URL to a port of its own — see
    # `agent37_exec`. Ignored unless `persistDisk`.
    publicUrl: bool = False
    # An agent bullet run in its own session on the shared Agent37 instance, so
    # its conversation and folder outlive the run — see `agent37_exec`. Overrides every other agent option
    # but the step limit and producing files.
    persistDisk: bool = False
    # A python bullet's extra sandbox packages, comma-separated — see
    # `modal_exec.config_line`. Ignored on every other kind.
    packages: str = ""
    # Hold this bullet's answer to JSON — promptmap's `output_format="json"`.
    jsonOutput: bool = False
    # Reuse promptmap's cached answer. Off, it gets promptmap's `config(cache=False)`.
    cache: bool = True
    # A test bullet's judge: "llm" asks the run's model for a verdict,
    # "classifier" asks the classifier for P(yes) and passes at `threshold`.
    judge: str = "llm"
    threshold: float = 0.5
    # The model this bullet calls; empty for the run's (`LLM_MODEL_VAR`). Goes
    # into its `config(model=…)`, where `llm.py` and the agent kinds read it.
    model: str = ""
    # A prompt or agent bullet told where it sits in the map: promptmap's
    # `org_outline()` renders the bullets around it as a tree below its text.
    outline: bool = False


class ClassifierSettings(BaseModel):
    """Settings → classifier: any `/v1/systemone` endpoint (see
    `promptmap.systemone_classifier`). Empty fields take promptmap's defaults — hosted Jev."""

    apiKey: str = ""
    baseUrl: str = ""
    model: str = ""


class RunRequest(BaseModel):
    nodes: list[Node]
    provider: str = "gemini"
    apiKey: Optional[str] = None
    # Files are namespaced per browser session; see `files.py`.
    sessionId: str = ""
    # Settings → "global instruction": prompt text promptmap renders into every
    # bullet's prompt (templates and python bullets opt out). Empty means none.
    globalInstruction: str = ""
    # Settings → run variables, name → value. A bullet writes `@name`; promptmap is
    # handed the map and renders `{{ promptdata("name") }}` from it.
    promptdata: dict[str, str] = {}
    classifier: ClassifierSettings = ClassifierSettings()
    # Settings → agent steps: how many steps an agent bullet may take before it
    # is told to answer. 0 means the server's default (see `agent_exec`).
    agentSteps: int = 0
    # Settings → the user's own Agent37 key. Empty runs preserve-disk agents on
    # the server's shared instance; set, on an instance in the user's workspace.
    agent37Key: str = ""
    # Run just these bullets and what feeds them (promptmap's `select`). Empty runs
    # the whole graph.
    select: list[str] = []
    # Settings → parallel bullets: most bullets running at once. 0 means the
    # server's default (`DEFAULT_PARALLEL`); capped at `MAX_PARALLEL`.
    maxParallel: int = 0


class ExportRequest(BaseModel):
    """A graph on its way *out* of the app, as a promptmap project you can run."""

    # "script" — one file that runs the pipeline; "project" — one file that
    # writes the map/ + client.py layout `promptmap serve` expects.
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
    # The files each bullet produced, same keys — see `_file_info`.
    files: dict[str, list[dict]] = {}
    errors: list[str] = []


def _has_key(provider: str, api_key: Optional[str]) -> bool:
    """Whether the UI sent a key — the only place `llm.py` looks, checked before
    the graph is built so "no key" is one answer rather than an error on every
    bullet."""
    return bool(api_key)


def _build_source(
    node: Node,
    child_ids: list[str],
    id_to_slug: dict[str, str],
    session_id: str = "",
    var_names: set[str] | None = None,
    file_sources: set[str] | None = None,
    provider: str = "gemini",
) -> str:
    """Compose a bullet's promptmap prompt.

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
    line — promptmap's built-in passthrough kind: no LLM call, the rendered text
    is the output. A search node is a template whose text becomes a query.

    A python node gets the `python_modal` config line instead, and its refs go
    into a Jinja *comment* — see `_python_source`. An agent node keeps the
    ordinary shape — its rendered text is the agent's task — plus the `agent_modal` config line naming its MCP server, if
    any (see `agent_exec.py`).

    A prompt bullet fed by one in *file_sources* — an agent set to produce
    files — declares it in `promptfiles`, so promptmap hands it those files too.

    Any `@name` naming a run variable becomes `{{ promptdata("name") }}` on the
    way through, which is how the values reach the prompt (see `_as_promptdata`).

    A bullet with a model of its own carries it as `config(model=…)`; one set to
    know its place gets promptmap's `org_outline()` after its text.
    """
    source = _compose_source(node, child_ids, id_to_slug, session_id, var_names, file_sources, provider)
    own_model = _model_id(node.model)
    if own_model and _calls_model(node):
        source = '{{ config(%s="%s") }}\n' % (MODEL_KEY, own_model) + source
    return source


def _compose_source(
    node: Node,
    child_ids: list[str],
    id_to_slug: dict[str, str],
    session_id: str,
    var_names: set[str] | None,
    file_sources: set[str] | None,
    provider: str,
) -> str:
    dep_ids = _deps(node, child_ids, id_to_slug)
    dep_slugs = [id_to_slug[d] for d in dep_ids]
    if node.kind == "python":
        return _python_source(node, dep_slugs, node.packages)

    if node.kind == "test":
        # The assertion, then the verdict it wants, then what it is about. A
        # mention only connects the test; it is not inlined, or the material
        # would land inside the assertion and leave "Material under test" empty.
        text = _escape_jinja(_test_assertion(_as_promptdata(node.text.strip(), var_names or set())))
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
    prompt = _json_body(node, _escape_jinja(text))
    # Only what has nowhere else to be: a reference already standing in the
    # sentence must not also be pasted underneath it.
    ref_lines = ["{{ ref('%s') }}" % id_to_slug[d] for d in dep_ids if d not in inlined]
    source = "\n".join([prompt, *ref_lines]) if ref_lines else prompt
    if node.kind == "search":
        return "\n".join([TEMPLATE_CONFIG_LINE, SEARCH_OPEN + source + _search_close(provider)])
    if node.outline and node.kind in ("prompt", "agent"):
        source += OUTLINE_BLOCK
    if node.jsonOutput:
        source = JSON_CONFIG_LINE + "\n" + source
    if node.kind == "template":
        source = TEMPLATE_CONFIG_LINE + "\n" + source
    if not node.cache and node.kind in ("prompt", "agent"):
        source = NO_CACHE_CONFIG_LINE + "\n" + source
    if node.kind == "agent" and node.persistDisk:
        if node.publicUrl:
            source += PUBLIC_URL_INSTRUCTION
        return (
            agent37_exec.config_line(
                node.id, node.agentSteps, node.producesFiles, node.remoteBrowser, node.publicUrl
            )
            + "\n"
            + source
        )
    if node.kind == "agent":
        # The sandbox never sees attachments, so none are declared either.
        return (
            agent_exec.config_line(
                node.mcpServer,
                node.agentSteps,
                node.producesFiles,
                node.agentBackoff,
                node.remoteBrowser,
            )
            + "\n"
            + source
        )
    keys = _node_file_keys(node, session_id)
    if node.kind == "prompt":
        # Only a prompt reaches a model that can look at them; a template
        # passes text through, and promptmap fails a bullet that asks for files from
        # one that produced none — hence only those set to produce them.
        keys += [id_to_slug[d] for d in dep_ids if d in (file_sources or set())]
    if keys:
        source = _promptfiles_line(keys) + "\n" + source
    return source


def _native_test_source(
    node: Node, child_ids: list[str], id_to_slug: dict[str, str], var_names: set[str]
) -> str:
    """A test bullet as a promptmap test (`*.testprompt`), for an export.

    The same assertion and material as `_build_source` gives it, in the shape
    promptmap's own tester judges: `{"results": "pass"}` from an LLM, or P(yes)
    from the run's `classify_call` for a classifier-judged one.
    """
    text = _escape_jinja(_test_assertion(_as_promptdata(node.text.strip(), var_names)))
    ref_lines = ["{{ ref('%s') }}" % id_to_slug[d] for d in _deps(node, child_ids, id_to_slug)]
    if _is_classifier(node):
        config = '{{ config(judge="classifier", threshold="%s") }}' % _threshold(node)
        return "\n".join([config, text, CLASSIFIER_SEPARATOR, *ref_lines])
    return "\n".join([text, NATIVE_TEST_INSTRUCTION, TEST_MATERIAL, *ref_lines])


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
    provider: str = "gemini",
) -> dict[str, str]:
    """Every bullet's promptmap source, keyed by its model name — for a run and an
    export alike."""
    feeds = _feeding(nodes, names)
    producers = {n.id for n in nodes if n.kind == "agent" and n.producesFiles}
    return {
        names[n.id]: _build_source(
            n, children[n.id], feeds, session_id, set(promptdata), producers, provider
        )
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
    """The pass mark for a classifier test, clamped to what promptmap accepts."""
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


def _upstream(
    ids: list[str],
    by_node: dict[str, Node],
    children: dict[str, list[str]],
    feeds: dict[str, str],
) -> set[str]:
    """These bullets and every bullet they depend on, however far back."""
    seen: set[str] = set()
    todo = list(ids)
    while todo:
        i = todo.pop()
        if i in seen:
            continue
        seen.add(i)
        todo.extend(_deps(by_node[i], children[i], feeds))
    return seen


def _python_source(node: Node, dep_slugs: list[str], packages: str = "") -> str:
    """A python bullet's source: its dependency, and nothing else.

    A python bullet holds no code of its own — it runs what its one child
    produced. So its own text never reaches the sandbox, and this source
    carries only the two directives promptmap needs.

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


def _prompt_shown(node: Node, rendered: str, dep_ids: list[str], live: dict[str, str]) -> str:
    """What the "Model input" column shows for a bullet that ran.

    promptmap's own `prompt_rendered` — exactly what was sent, global
    instruction, variables and `[ref]` tags included, and filled in for a
    cached answer too. A python bullet is the exception: its prompt is only its
    config line, and what runs is the code extracted from its child.
    """
    if node.kind == "python":
        return modal_exec._inherited_code([live[d] for d in dep_ids if d in live])
    return rendered.strip()


def _prompt_unsent(node: Node, status: str) -> str:
    """The "Model input" column for a bullet with no rendered prompt to show."""
    note = SKIPPED_NOTE if status == "skipped" else FAILED_NOTE
    text = node.text.strip() if node.kind != "python" else ""
    return note + ("\n\n" + text if text else "")


def _json_forms(text: str) -> tuple[str, str]:
    """A JSON answer's two forms: ``(what a person reads, what promptmap rendered)``.

    `output_format="json"` makes promptmap hand the *parsed* value downstream, and
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
    under *this bullet* within it. promptmap's promptfiles are a flat namespace, so a
    node naming someone else's key is ignored rather than trusted.
    """
    return [f.key for f in node.files if attachments.belongs_to(f.key, session_id, node.id)]


def _title(node: Node, others: dict[str, Node] | None = None) -> str:
    """What to call a bullet in a message to a person: its title.

    A model is named after the title too (`exporter.model_names`), but made
    safe for `ref('…')` — lowercased and underscored — which is the right name
    for the run and the wrong one for the sentence a person reads.
    """
    line = node.title.strip()
    if node.kind == "python" and not line:
        return "the python bullet"
    return f"“{line[:40]}…”" if len(line) > 40 else f"“{line}”" if line else "an empty bullet"


# A file is previewed in the browser from a data URL, which keeps the server
# stateless — nothing is stored to be fetched later. Past this size it goes to
# the attachments bucket instead, under the bullet that made it, and the
# browser asks for a short-lived link when it is downloaded (`/files/link`).
# Without a bucket it is listed by name alone.
PREVIEW_BYTES = 5 * 1024 * 1024


def _split_files(value: Any) -> tuple[Any, list[promptmap.File]]:
    """A result's files, and what is left of it once they are taken out."""
    if not contains_files(value):
        return value, []
    files = [f for _, f in iter_files(value)]
    if isinstance(value, promptmap.Output):
        return value.text, files
    if isinstance(value, dict):
        return {k: v for k, v in value.items() if not contains_files(v)}, files
    return "", files


def _text(value: Any) -> str:
    """A result as text: itself if it is text, JSON if it is structured."""
    if isinstance(value, str):
        return value
    return json.dumps(to_jsonable(value), ensure_ascii=False)


def _file_info(f: promptmap.File, session_id: str, bullet_id: str, stored: dict) -> dict:
    """What the browser is told about a file: enough to list it, and either its
    bytes as a data URL when it is small enough to preview, or the bucket key
    to fetch a download link for. `stored` holds the keys already uploaded this
    run, so a file reported twice (live, then in the final result) is stored
    once."""
    info = {"name": f.name, "mime": f.mime, "size": f.size, "url": "", "key": ""}
    if f.size <= PREVIEW_BYTES:
        info["url"] = f"data:{f.mime};base64," + base64.b64encode(f.read_bytes()).decode()
    elif session_id and attachments.enabled():
        cache = (bullet_id, f.name, f.size)
        if cache not in stored:
            try:
                stored[cache] = attachments.put(session_id, bullet_id, f.name, f.read_bytes())["key"]
            except Exception:  # noqa: BLE001 — listed by name alone, as without a bucket
                stored[cache] = ""
        info["key"] = stored[cache]
    return info


def _serialise(
    outputs: dict[str, Any], titles: dict[str, str] | None = None
) -> tuple[dict[str, str], list[str]]:
    """Split promptmap outputs into text results and error strings.

    A skip is reported as an error line too — it is what happens *to* a bullet
    when something it depends on fails. Files were already taken from each
    result as it landed (see `on_done`), so only the text is kept here.
    """
    titles = titles or {}
    results: dict[str, str] = {}
    errors: list[str] = []
    for name, value in outputs.items():
        label = titles.get(name, name)
        if isinstance(value, promptmap.ModelError):
            errors.append(f"{label}: {value.message}")
        elif isinstance(value, promptmap.ModelStatus):
            errors.append(f"{label}: skipped — something it needs did not run.")
        else:
            # Stripped because a template bullet's output is its own rendered
            # source, and the injected `{{ config(...) }}` line renders to an
            # empty first line.
            results[name] = _text(_split_files(value)[0]).strip()
    return results, errors


app = FastAPI(title="Visual Prompt Map runner", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(accounts.router)
app.include_router(bug_reports.router)


@app.get("/healthz")
def health() -> dict:
    """Lightweight health check."""
    return {"status": "ok", "promptmap_version": promptmap.__version__}


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
    """Whether agent bullets can run here — they need Modal, as python does —
    and the step limits a run may choose between."""
    return {
        "enabled": agent_exec.enabled(),
        "persistDisk": agent37_exec.enabled(),
        "rejected": agent_exec.rejected(),
        "defaultSteps": agent_exec.STEP_LIMIT,
        "maxSteps": agent_exec.MAX_STEP_LIMIT,
        # How many bullets a run works on at once — see `DEFAULT_PARALLEL`.
        "defaultParallel": DEFAULT_PARALLEL,
        "maxParallel": MAX_PARALLEL,
    }


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
    """The graph as a promptmap project, built from the same sources a run uses.

    Nothing here is stored and nothing runs — this is `_build_source` over the
    same graph, named for reading rather than for uniqueness, wrapped in a file.
    """
    nodes = _runnable(req.nodes)
    if not nodes:
        return ExportResponse(errors=["Nothing to export — every bullet is empty."])

    promptdata = _clean_promptdata(req.promptdata)
    # The same readable names a run uses: file names and `ref('…')` calls that
    # a person is going to read and edit.
    id_to_name = exporter.model_names(nodes)
    children = _children(nodes)
    # Test bullets leave as promptmap tests, not models: nothing depends on a
    # test (see `_feeding`), so taking them out of the models breaks no ref().
    feeds = _feeding(nodes, id_to_name)
    tests = {
        id_to_name[n.id]: _native_test_source(n, children[n.id], feeds, set(promptdata))
        for n in nodes
        if n.kind == "test"
    }
    models = {
        name: src
        for name, src in _models(
            nodes, children, id_to_name, req.sessionId, promptdata, req.provider
        ).items()
        if name not in tests
    }

    notes = exporter.warnings(nodes, req.provider)
    build = exporter.project if req.target == "project" else exporter.script
    # The run's model — Settings' `llm_model`, else the server's default — goes
    # into settings.yml; a bullet's own stays in its `config(model=…)`.
    model = _llm_model(promptdata) or (model_name(req.provider) if req.provider in PROVIDERS else "")
    return ExportResponse(
        filename=exporter.filename(req.name, req.target),
        text=build(
            req.name,
            models,
            tests,
            req.provider,
            model,
            req.globalInstruction.strip(),
            promptdata,
            notes,
        ),
        warnings=notes,
    )


@app.post("/run")
async def run(req: RunRequest, authorization: Optional[str] = Header(None)) -> StreamingResponse:
    """Run the graph, streaming its progress as newline-delimited JSON.

    One event per line, so the UI can show a run as it happens rather than a
    spinner followed by everything at once:

    - ``plan``  — every bullet about to run, with the title to call it by;
    - ``start`` — a bullet has started;
    - ``log``   — one line of a running agent bullet's log, as it happens;
    - ``done``  — a bullet finished: ``success`` with its answer and the prompt
      it was sent, ``error`` with promptmap's message, or ``skipped``;
    - ``final`` — the whole `RunResponse`, the same answer a batch run gives.
      A run that never starts (no key, nothing to run) sends only this.
    """
    # Who is running, for their own Hermes profile on Agent37: the signed-in
    # email, else this browser's session id.
    user = accounts.user_or_none(authorization) or req.sessionId
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def emit(event: dict) -> None:
        # promptmap may call back from a worker thread when `llm_call` is sync.
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def work() -> None:
        try:
            final = await _run(req, emit, user)
        except Exception as exc:  # noqa: BLE001 — surface any failure to the client
            final = RunResponse(errors=[str(exc)])
        emit({"type": "final", **final.model_dump()})
        emit(None)

    async def lines():
        task = asyncio.create_task(work())
        try:
            while (event := await queue.get()) is not None:
                yield json.dumps(event, ensure_ascii=False) + "\n"
        finally:
            task.cancel()  # the browser went away: stop spending on its run

    return StreamingResponse(lines(), media_type="application/x-ndjson")


async def _run(req: RunRequest, emit: Callable[[dict], None], user: str = "") -> RunResponse:
    if req.provider not in PROVIDERS:
        return RunResponse(errors=[f"Unsupported provider: {req.provider}"])

    if not _has_key(req.provider, req.apiKey):
        return RunResponse(needsKey=True, errors=["Enter an API key to run models."])

    global_instruction = req.globalInstruction.strip()
    # The variables the run may use. `@name`s in the bullets are rewritten
    # against these names, and promptmap is handed the values.
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

    # Models are named after their bullets' titles — readable in a `[ref]` tag,
    # an error message and `org_outline()` — and unique within the run.
    id_to_slug = exporter.model_names(nodes)
    slug_to_id = {v: k for k, v in id_to_slug.items()}
    by_node = {n.id: n for n in nodes}
    titles = {n.id: _title(n, by_node) for n in nodes}

    children = _children(nodes)
    models = _models(nodes, children, id_to_slug, req.sessionId, promptdata, req.provider)
    feeds = _feeding(nodes, id_to_slug)
    llm_model = _llm_model(promptdata)

    # A selected run is the selection and everything upstream of it: promptmap works
    # that out from the models itself, but the plan and verdicts sent back should
    # name only what will actually run.
    select = [i for i in req.select if i in by_node]
    if req.select and not select:
        return RunResponse(errors=["The bullet to run is empty or not runnable."])
    in_run = _upstream(select, by_node, children, feeds) if select else set(by_node)
    planned = [n for n in nodes if n.id in in_run]

    # Pull each bullet's attachments once, keyed the way the config declares
    # them, so promptmap can route them to the model that asked.
    promptfiles: dict[str, Any] = {}
    try:
        for n in planned:
            if n.kind in ("python", "agent", "test"):
                continue  # a sandbox never sees attachments — don't fetch them
            for key in _node_file_keys(n, req.sessionId):
                if key not in promptfiles:
                    promptfiles[key] = attachments.get(key)
    except Exception as exc:  # noqa: BLE001 — a missing object shouldn't 500
        return RunResponse(errors=[f"Could not read an attached file: {exc}"])

    emit({"type": "plan", "models": [{"id": n.id, "title": titles[n.id]} for n in planned]})

    # Gathered as each bullet lands. `live_rendered` is what downstream prompts
    # rendered for it — a python bullet's input is read from there.
    live_rendered: dict[str, str] = {}
    prompts: dict[str, str] = {}
    tests: dict[str, str] = {}
    files: dict[str, list[dict]] = {}
    # Bucket keys of the large files this run produced — see `_file_info`.
    stored: dict = {}

    def on_start(name: str) -> None:
        emit({"type": "start", "id": slug_to_id.get(name, name)})

    def on_done(result: promptmap.ModelRunResult) -> None:
        node_id = slug_to_id.get(result.model_name, result.model_name)
        event: dict[str, Any] = {
            "type": "done",
            "id": node_id,
            "status": result.status,
            "ms": result.execution_ms,
            "cached": result.cached,
            # How it was produced: "" (ran), "cache", "cache_check", … — see
            # `promptmap.executor.executor.CACHE_LABELS`.
            "cache": result.cache,
            "error": result.error,
        }
        # promptmap names upstream models in its errors ("upstream models
        # failed: ['topic']"); a person knows them by their title.
        for slug, other in slug_to_id.items():
            event["error"] = event["error"].replace(f"'{slug}'", titles[other])
        node = by_node.get(node_id)
        if node and result.status == "success":
            value = result.value if result.value is not None else result.llm_output
            rest, made = _split_files(value)
            text = _text(rest).strip()
            shown, rendered = text, text
            if node.jsonOutput or node.kind in ("agent", "test"):
                shown, rendered = _json_forms(text)
            if made:
                # What promptmap put in a downstream prompt: the whole value, each
                # file as its one-line handle.
                rendered = str(value)
                files[node_id] = [_file_info(f, req.sessionId, node_id, stored) for f in made]
                event["files"] = files[node_id]
            live_rendered[node_id] = rendered
            deps = _deps(node, children[node_id], feeds)
            prompts[node_id] = _prompt_shown(node, result.prompt_rendered, deps, live_rendered)
            event["output"] = shown
            event["prompt"] = prompts[node_id]
            if node.kind == "test":
                tests[node_id] = event["test"] = _verdict(shown)
        elif node:
            prompts[node_id] = event["prompt"] = _prompt_unsent(node, result.status)
            if node.kind == "test" and result.status == "skipped":
                tests[node_id] = event["test"] = "skipped"
        try:
            emit(event)
        except Exception:  # noqa: BLE001 — a progress event is never worth failing the run
            pass

    # Agent bullets call the model from inside their sandbox, so they need this
    # run's provider and key too — bound for the tasks promptmap spawns, not globally —
    # along with its step limit and where to send their log lines live.
    run_token = agent_exec.use_run(
        agent_exec.RunSettings(
            provider=req.provider,
            api_key=req.apiKey,
            model=llm_model,
            steps=agent_exec.steps_for(req.agentSteps),
            agent37_key=req.agent37Key.strip() or None,
            user=user,
            on_log=lambda name, line: emit(
                {"type": "log", "id": slug_to_id.get(name, name), "line": line}
            ),
        )
    )
    # Search bullets search on the same provider and key — see `search.py`.
    search_token = search.use_key(req.provider, req.apiKey)
    try:
        llm = make_llm_call(
            api_key=req.apiKey,
            provider=req.provider,
            classifier=req.classifier.model_dump(),
            model=llm_model,
        )
        outputs = await promptmap.async_run(
            models_from_dict=models,
            llm_call=llm,
            promptfiles=promptfiles or None,
            promptdata=promptdata or None,
            # `ref()` is refused inside a global instruction — promptmap says as much
            # and points at promptdata — but a variable is exactly what belongs
            # there, so `@name` is rewritten here too.
            global_instruction=_escape_jinja(
                _as_promptdata(global_instruction, var_names), _ALLOWED_GLOBAL_JINJA
            ) or None,
            select=[id_to_slug[i] for i in select] or None,
            verbose=False,
            # Tag each `ref()` with its bullet's name so the LLM can tell inputs apart.
            wrap_refs=True,
            max_parallel=_parallel(req.maxParallel),
            on_model_start=on_start,
            on_model_done=on_done,
        )
    finally:
        search.reset_key(search_token)
        agent_exec.reset_run(run_token)

    results, errors = _serialise(
        outputs, {id_to_slug[n.id]: titles[n.id] for n in nodes}
    )
    by_id = {slug_to_id.get(name, name): value for name, value in results.items()}
    # Anything structured is shown pretty-printed — see `_json_forms`.
    for n in nodes:
        if (n.jsonOutput or n.kind in ("agent", "test")) and n.id in by_id:
            by_id[n.id] = _json_forms(by_id[n.id])[0]
    # A test that errored itself never said it passed.
    for n in planned:
        if n.kind == "test":
            tests.setdefault(n.id, "fail")
    return RunResponse(outputs=by_id, prompts=prompts, tests=tests, files=files, errors=errors)


def _parallel(requested: int) -> int:
    """The run's `max_parallel`: the request's, else the default, within bounds."""
    return min(MAX_PARALLEL, max(1, requested or DEFAULT_PARALLEL))


# Serve the built frontend last, so `/run` and `/healthz` take precedence.
# `html=True` serves index.html at `/`. Absent in dev (no dist/) — skipped.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
