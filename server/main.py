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

import files as attachments
import modal_exec
from llm import make_llm_call

# Teach pbt about `model_type="python_modal"` once, at import.
modal_exec.register()

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

# Attachments reach the model the same way: pbt parses the declared names out
# of the config block and hands the matching files to `llm_call(files=...)`.
def _promptfiles_line(keys: list[str]) -> str:
    return "{{ config(promptfiles='%s') }}" % json.dumps(keys)


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
    # "prompt" | "template" | "python" — see `_build_source`. Anything else is
    # treated as a prompt rather than rejected: a bullet is not worth a 422.
    kind: str = "prompt"


class RunRequest(BaseModel):
    nodes: list[Node]
    provider: str = "gemini"
    apiKey: Optional[str] = None
    # Files are namespaced per browser session; see `files.py`.
    sessionId: str = ""
    # Settings → "global instruction": prompt text pbt renders into every
    # bullet's prompt (templates and python bullets opt out). Empty means none.
    globalInstruction: str = ""


class RunResponse(BaseModel):
    # Keyed by the bullet id the client sent, so the UI can map results back.
    outputs: dict[str, str] = {}
    # The prompt each bullet was actually sent, same keys. The UI shows it
    # beside the answer, so "why did it say that" has an answer on screen.
    prompts: dict[str, str] = {}
    errors: list[str] = []


def _slug(node_id: str) -> str:
    """A pbt-safe model name derived from a bullet id (used in ref() too)."""
    return "n_" + re.sub(r"[^0-9a-zA-Z]", "_", node_id)


def _build_source(
    node: Node, child_ids: list[str], id_to_slug: dict[str, str], session_id: str = ""
) -> str:
    """Compose a bullet's pbt prompt.

    The bullet's own text comes **first**, then each dependency's output as a
    `{{ ref('...') }}` line below it — so a bullet reads as its instruction
    followed by the material that instruction is about, and "summarise what
    follows" means what it says. A node's **children are auto-included** (their
    outputs feed up into the parent) in child order, then any explicit `@`
    references. A child is not duplicated if it is also referenced explicitly.

    A template node additionally gets a `{{ config(model_type="template") }}`
    line, which pbt parses into `model.config` and hands to `llm_call`, where
    it short-circuits into a passthrough instead of an LLM call.

    A python node gets the `python_modal` config line instead, and its refs go
    into a Jinja *comment* — see `_python_source`.
    """
    dep_ids = _deps(node, child_ids, id_to_slug)
    dep_slugs = [id_to_slug[d] for d in dep_ids]
    if node.kind == "python":
        return _python_source(node, dep_slugs)

    ref_lines = ["{{ ref('%s') }}" % slug for slug in dep_slugs]
    prompt = node.text.strip()
    source = "\n".join([prompt, *ref_lines]) if ref_lines else prompt
    if node.kind == "template":
        source = TEMPLATE_CONFIG_LINE + "\n" + source
    keys = _node_file_keys(node, session_id)
    if keys:
        source = _promptfiles_line(keys) + "\n" + source
    return source


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


def _python_source(node: Node, dep_slugs: list[str]) -> str:
    """A python bullet's source: its dependency, and nothing else.

    A python bullet holds no code of its own — it runs what its one child
    produced. So its own text never reaches the sandbox, and this source
    carries only the two directives pbt needs.

    The refs go inside a Jinja *comment* rather than on their own lines the way
    a prompt bullet's do. `extract_dependencies` scans the raw source with a
    regex, so the ordering and the parallelism still come out right, while the
    comment renders to nothing — leaving no upstream text pasted into what is
    about to be compiled as Python. The outputs reach the sandbox as `inputs`,
    injected by `PythonModalExec` in dependency order (see `modal_exec.py`).

    Attachments are deliberately not declared here: the sandbox is a different
    machine and never sees them, so there is nothing to fetch from the bucket.
    """
    lines = [modal_exec.CONFIG_LINE]
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
    node: Node, dep_ids: list[str], results: dict[str, str], global_instruction: str = ""
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
    parts = [results[d] for d in dep_ids if d in results]
    if node.kind == "python":
        return modal_exec._inherited_code(parts)
    body = "\n".join([node.text.strip(), *parts]) if parts else node.text.strip()
    if global_instruction and node.kind != "template":
        return global_instruction.rstrip("\n") + "\n\n" + body
    return body


def _node_file_keys(node: Node, session_id: str) -> list[str]:
    """The attachments this bullet may use — its own, and nothing else.

    Two gates: the key must sit under the *session* that sent the request, and
    under *this bullet* within it. pbt's promptfiles are a flat namespace, so a
    node naming someone else's key is ignored rather than trusted.
    """
    return [f.key for f in node.files if attachments.belongs_to(f.key, session_id, node.id)]


def _serialise(outputs: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    """Split pbt outputs into plain results and error strings."""
    results: dict[str, str] = {}
    errors: list[str] = []
    for name, value in outputs.items():
        if isinstance(value, pbt.ModelError):
            errors.append(f"{name}: {value.message}")
        elif isinstance(value, pbt.ModelStatus):
            errors.append(f"{name}: {value.value}")
        else:
            text = value if isinstance(value, str) else str(value)
            # Stripped because a template bullet's output is its own rendered
            # source, and the injected `{{ config(...) }}` line renders to an
            # empty first line.
            results[name] = text.strip()
    return results, errors


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
    """Whether Modal is configured — the UI hides `python` bullets if not."""
    return {"enabled": modal_exec.enabled()}


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


@app.post("/run", response_model=RunResponse)
async def run(req: RunRequest) -> RunResponse:
    if req.provider not in PROVIDERS:
        return RunResponse(errors=[f"Unsupported provider: {req.provider}"])

    global_instruction = req.globalInstruction.strip()

    nodes = _runnable(req.nodes)
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

    # Children feed their parent: build the parent → child-ids map from parentId.
    children: dict[str, list[str]] = {n.id: [] for n in nodes}
    for n in nodes:
        if n.parentId in children:
            children[n.parentId].append(n.id)

    models = {
        id_to_slug[n.id]: _build_source(n, children[n.id], id_to_slug, req.sessionId)
        for n in nodes
    }

    # Pull each bullet's attachments once, keyed the way the config declares
    # them, so pbt can route them to the model that asked.
    promptfiles: dict[str, Any] = {}
    try:
        for n in nodes:
            if n.kind == "python":
                continue  # the sandbox never sees attachments — don't fetch them
            for key in _node_file_keys(n, req.sessionId):
                if key not in promptfiles:
                    promptfiles[key] = attachments.get(key)
    except Exception as exc:  # noqa: BLE001 — a missing object shouldn't 500
        return RunResponse(errors=[f"Could not read an attached file: {exc}"])

    try:
        llm = make_llm_call(api_key=req.apiKey, provider=req.provider)
        outputs = await pbt.async_run(
            models_from_dict=models,
            llm_call=llm,
            promptfiles=promptfiles or None,
            global_instruction=global_instruction or None,
            verbose=False,
        )
    except Exception as exc:  # noqa: BLE001 — surface any failure to the client
        return RunResponse(errors=[str(exc)])

    results, errors = _serialise(outputs)
    by_id = {slug_to_id.get(name, name): value for name, value in results.items()}
    prompts = {
        n.id: _model_input(n, _deps(n, children[n.id], id_to_slug), by_id, global_instruction)
        for n in nodes
    }
    return RunResponse(outputs=by_id, prompts=prompts, errors=errors)


# Serve the built frontend last, so `/run` and `/healthz` take precedence.
# `html=True` serves index.html at `/`. Absent in dev (no dist/) — skipped.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
