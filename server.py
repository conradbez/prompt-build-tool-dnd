"""
Minimal pbt DAG server — single file.
Run with: uvicorn server:app --reload
"""

import json
import traceback
from typing import List, Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import pbt

app = FastAPI(title="pbt DAG server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunResponse(BaseModel):
    outputs: dict
    errors: list[str] = []


def _make_llm_call(provider: str, api_key: str | None):
    """Return a provider-specific llm_call function for pbt.run()."""
    import os

    if provider == "gemini":
        import google.generativeai as genai
        key = api_key or os.environ.get("GEMINI_API_KEY", "")
        genai.configure(api_key=key)
        model = genai.GenerativeModel("gemini-2.0-flash")
        def call(prompt: str) -> str:
            return model.generate_content(prompt).text
        return call

    if provider == "openai":
        from openai import OpenAI
        client = OpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"))
        def call(prompt: str) -> str:
            return client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
            ).choices[0].message.content
        return call

    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"))
        def call(prompt: str) -> str:
            return client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            ).content[0].text
        return call

    raise ValueError(f"Unsupported provider: {provider}")


def _serialise(outputs: dict) -> tuple[dict, list[str]]:
    serialised, errors = {}, []
    for name, value in outputs.items():
        if isinstance(value, pbt.ModelError):
            errors.append(f"{name}: {value.message}")
        elif isinstance(value, pbt.ModelStatus):
            errors.append(f"{name}: {value.value}")
        else:
            serialised[name] = value
    return serialised, errors


def _inline_template_source(source: str) -> str:
    return "{{skip_and_set_to_value(" + json.dumps(source) + ")}}"


@app.get("/health")
def health():
    return {"status": "ok", "pbt_version": pbt.__version__}


@app.post("/dag/run", response_model=RunResponse)
async def dag_run(
    nodes: str = Form(..., description='JSON array of {name, source, isTemplate?} objects'),
    select: Optional[List[str]] = Form(None),
    promptdata: Optional[str] = Form(None),
    promptfiles: Optional[List[UploadFile]] = File(None),
    provider: str = Form("gemini"),
    api_key: Optional[str] = Form(None),
) -> RunResponse:
    try:
        nodes_list = json.loads(nodes)
        models_dict = {
            n["name"]: _inline_template_source(n["source"]) if n.get("isTemplate") else n["source"]
            for n in nodes_list
        }
    except Exception as exc:
        return RunResponse(outputs={}, errors=[f"Invalid nodes: {exc}"])

    pd = json.loads(promptdata) if promptdata else None
    pf = None
    if promptfiles:
        pf = {}
        for f in promptfiles:
            raw = f.filename or ""
            key = raw.rsplit(".", 1)[0] if "." in raw else raw
            pf[key] = f.file

    try:
        llm_call = _make_llm_call(provider, api_key)
        outputs = pbt.run(
            models_from_dict=models_dict,
            select=select or None,
            promptdata=pd,
            promptfiles=pf,
            llm_call=llm_call,
            verbose=False,
        )
    except Exception as exc:
        traceback.print_exc()
        return RunResponse(outputs={}, errors=[str(exc)])

    serialised, errors = _serialise(outputs)
    return RunResponse(outputs=serialised, errors=errors)
