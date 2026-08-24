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

import re
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import pbt

from llm import make_llm_call

PROVIDERS = {"gemini", "openai", "anthropic"}


class Node(BaseModel):
    id: str
    title: str = ""
    body: str = ""
    refs: list[str] = []


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


def _build_source(node: Node, id_to_slug: dict[str, str]) -> str:
    """Compose a bullet's pbt prompt: ref() lines for its dependencies, then its text."""
    ref_lines = [
        "{{ ref('%s') }}" % id_to_slug[r]
        for r in node.refs
        if r in id_to_slug
    ]
    if node.title.strip() and node.body.strip():
        prompt = f"{node.title.strip()}\n{node.body.strip()}"
    else:
        prompt = (node.body or node.title).strip()
    return ("\n".join(ref_lines) + "\n" + prompt) if ref_lines else prompt


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


@app.get("/")
def health() -> dict:
    """Lightweight health check (also used by Railway)."""
    return {"status": "ok", "pbt_version": pbt.__version__}


@app.post("/run", response_model=RunResponse)
def run(req: RunRequest) -> RunResponse:
    if req.provider not in PROVIDERS:
        return RunResponse(errors=[f"Unsupported provider: {req.provider}"])

    # Only run bullets that actually have content.
    nodes = [n for n in req.nodes if (n.body.strip() or n.title.strip())]
    if not nodes:
        return RunResponse(errors=["No non-empty bullets to run."])

    id_to_slug = {n.id: _slug(n.id) for n in nodes}
    slug_to_id = {v: k for k, v in id_to_slug.items()}
    models = {id_to_slug[n.id]: _build_source(n, id_to_slug) for n in nodes}

    try:
        llm = make_llm_call(api_key=req.apiKey, provider=req.provider)
        outputs = pbt.run(models_from_dict=models, llm_call=llm, verbose=False)
    except Exception as exc:  # noqa: BLE001 — surface any failure to the client
        return RunResponse(errors=[str(exc)])

    results, errors = _serialise(outputs)
    by_id = {slug_to_id.get(name, name): value for name, value in results.items()}
    return RunResponse(outputs=by_id, errors=errors)
