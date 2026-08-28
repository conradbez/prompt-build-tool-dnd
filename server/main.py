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

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pbt

import files as attachments
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
TEMPLATE_CONFIG_LINE = '{{ config(model_type="template") }}'

# Attachments reach the model the same way: pbt parses the declared names out
# of the config block and hands the matching files to `llm_call(files=...)`.
def _promptfiles_line(keys: list[str]) -> str:
    return "{{ config(promptfiles='%s') }}" % json.dumps(keys)


class FileRef(BaseModel):
    """An attachment on a bullet: the object key plus its original name."""

    key: str
    name: str = ""


class Node(BaseModel):
    id: str
    # One markdown text field per bullet; `@` mentions arrive already expanded.
    text: str = ""
    files: list[FileRef] = []
    parentId: Optional[str] = None
    refs: list[str] = []
    # Template nodes are not sent to the LLM — see `_build_source` / `llm.py`.
    template: bool = False


class RunRequest(BaseModel):
    nodes: list[Node]
    provider: str = "gemini"
    apiKey: Optional[str] = None


class RunResponse(BaseModel):
    # Keyed by the bullet id the client sent, so the UI can map results back.
    outputs: dict[str, str] = {}
    errors: list[str] = []


def _slug(node_id: str) -> str:
    """A pbt-safe model name derived from a bullet id (used in ref() too)."""
    return "n_" + re.sub(r"[^0-9a-zA-Z]", "_", node_id)


def _build_source(node: Node, child_ids: list[str], id_to_slug: dict[str, str]) -> str:
    """Compose a bullet's pbt prompt.

    Dependencies become `{{ ref('...') }}` lines prepended to the text so the
    referenced outputs flow in. A node's **children are auto-included** — their
    outputs feed up into the parent — plus any explicit `@` references. A child
    is not duplicated if it is also referenced explicitly.

    A template node additionally gets a `{{ config(model_type="template") }}`
    line, which pbt parses into `model.config` and hands to `llm_call`, where
    it short-circuits into a passthrough instead of an LLM call.
    """
    dep_ids: list[str] = []
    for c in child_ids:
        if c in id_to_slug:
            dep_ids.append(c)
    for r in node.refs:
        if r in id_to_slug and r not in dep_ids:
            dep_ids.append(r)

    ref_lines = ["{{ ref('%s') }}" % id_to_slug[d] for d in dep_ids]
    prompt = node.text.strip()
    source = ("\n".join(ref_lines) + "\n" + prompt) if ref_lines else prompt
    if node.template:
        source = TEMPLATE_CONFIG_LINE + "\n" + source
    keys = _node_file_keys(node)
    if keys:
        source = _promptfiles_line(keys) + "\n" + source
    return source


def _node_file_keys(node: Node) -> list[str]:
    """The attachments this bullet may use — its own, and nothing else.

    pbt's promptfiles are a flat namespace, so a bullet asking for a key that
    doesn't sit under its own prefix is simply ignored rather than trusted.
    """
    return [f.key for f in node.files if attachments.belongs_to(f.key, node.id)]


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
            results[name] = value if isinstance(value, str) else str(value)
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


@app.post("/files")
async def upload(bulletId: str = Form(...), file: UploadFile = File(...)) -> dict:
    """Attach one file to one bullet."""
    if not attachments.enabled():
        return {"error": "File storage is not configured on this server."}
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return {"error": f"That file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."}
    try:
        return attachments.put(bulletId, file.filename or "file", data)
    except Exception as exc:  # noqa: BLE001 — surface storage errors to the UI
        return {"error": str(exc)}


@app.post("/files/delete")
def remove_file(ref: FileRef) -> dict:
    if not attachments.enabled():
        return {"error": "File storage is not configured on this server."}
    try:
        attachments.delete(ref.key)
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


@app.post("/run", response_model=RunResponse)
async def run(req: RunRequest) -> RunResponse:
    if req.provider not in PROVIDERS:
        return RunResponse(errors=[f"Unsupported provider: {req.provider}"])

    # Only run bullets that actually have content.
    nodes = [n for n in req.nodes if n.text.strip()]
    if not nodes:
        return RunResponse(errors=["No non-empty bullets to run."])

    id_to_slug = {n.id: _slug(n.id) for n in nodes}
    slug_to_id = {v: k for k, v in id_to_slug.items()}

    # Children feed their parent: build the parent → child-ids map from parentId.
    children: dict[str, list[str]] = {n.id: [] for n in nodes}
    for n in nodes:
        if n.parentId in children:
            children[n.parentId].append(n.id)

    models = {id_to_slug[n.id]: _build_source(n, children[n.id], id_to_slug) for n in nodes}

    # Pull each bullet's attachments once, keyed the way the config declares
    # them, so pbt can route them to the model that asked.
    promptfiles: dict[str, Any] = {}
    try:
        for n in nodes:
            for key in _node_file_keys(n):
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
            verbose=False,
        )
    except Exception as exc:  # noqa: BLE001 — surface any failure to the client
        return RunResponse(errors=[str(exc)])

    results, errors = _serialise(outputs)
    by_id = {slug_to_id.get(name, name): value for name, value in results.items()}
    return RunResponse(outputs=by_id, errors=errors)


# Serve the built frontend last, so `/run` and `/healthz` take precedence.
# `html=True` serves index.html at `/`. Absent in dev (no dist/) — skipped.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
