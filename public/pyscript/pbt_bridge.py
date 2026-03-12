import asyncio
import base64
import io
import json
import re
import sys
import traceback
import types

from js import CustomEvent, Object
from pyodide.http import pyfetch
from pyscript import ffi, window

sys.path.append("./vendor")

fake_db = types.ModuleType("pbt.db")
fake_db.init_db = lambda: None
fake_db.create_run = lambda *args, **kwargs: "browser-run"
fake_db.finish_run = lambda *args, **kwargs: None
fake_db.get_cached_llm_output = lambda *args, **kwargs: None
fake_db.upsert_model_pending = lambda *args, **kwargs: None
fake_db.mark_model_running = lambda *args, **kwargs: None
fake_db.mark_model_success = lambda *args, **kwargs: None
fake_db.mark_model_error = lambda *args, **kwargs: None
fake_db.mark_model_skipped = lambda *args, **kwargs: None
sys.modules.setdefault("pbt.db", fake_db)

from pbt import ModelError, ModelStatus  # noqa: E402
from pbt.executor.graph import build_models_from_dict, execution_order  # noqa: E402
from pbt.executor.parser import render_prompt  # noqa: E402

_JSON_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)
_GEMINI_DEFAULT_MODEL = "gemini-2.0-flash"


def _dispatch_status(message: str) -> None:
    detail = ffi.to_js({"detail": {"message": message}})
    event = CustomEvent.new("pbt:pyscript-status", detail)
    window.dispatchEvent(event)


def _inline_template_source(source: str) -> str:
    return "{{skip_and_set_to_value(" + json.dumps(source) + ")}}"


def _parse_json_output(raw: str):
    stripped = raw.strip()
    match = _JSON_FENCE.match(stripped)
    if match:
        stripped = match.group(1)
    return json.loads(stripped)


def _serialise(outputs: dict[str, object]) -> tuple[dict[str, object], list[str]]:
    serialised: dict[str, object] = {}
    errors: list[str] = []
    for name, value in outputs.items():
        if isinstance(value, ModelError):
            errors.append(f"{name}: {value.message}")
        elif isinstance(value, ModelStatus):
            errors.append(f"{name}: {value.value}")
        else:
            serialised[name] = value
    return serialised, errors


def _decode_promptfiles(items: list[dict] | None) -> dict[str, io.BytesIO] | None:
    if not items:
        return None

    promptfiles: dict[str, io.BytesIO] = {}
    for item in items:
        raw = base64.b64decode(item["dataBase64"])
        buffer = io.BytesIO(raw)
        buffer.name = item["fileName"]
        promptfiles[item["name"]] = buffer
    return promptfiles


async def _call_gemini(prompt: str, api_key: str, model: str) -> str:
    response = await pyfetch(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt}],
                    }
                ]
            }
        ),
    )

    payload = await response.json()
    if not response.ok:
        message = payload.get("error", {}).get("message", "Gemini request failed.")
        raise RuntimeError(message)

    candidates = payload.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "".join(part.get("text", "") for part in parts)
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text


async def _run_dag(payload_json: str) -> str:
    try:
        payload = json.loads(payload_json)
        provider = payload.get("provider") or "gemini"
        api_key = payload.get("apiKey")
        if provider != "gemini":
            raise ValueError("The PyScript runtime currently supports only Gemini.")
        if not api_key:
            raise ValueError("A Gemini API key is required for the PyScript runner.")

        nodes = payload.get("nodes") or []
        models_dict = {
            node["name"]: _inline_template_source(node["source"]) if node.get("isTemplate") else node["source"]
            for node in nodes
        }
        promptdata = payload.get("promptdata") or None
        select = set(payload.get("select") or [])
        promptfiles = _decode_promptfiles(payload.get("promptfiles"))

        all_models = build_models_from_dict(models_dict)
        ordered_models = execution_order(all_models)

        outputs: dict[str, object] = {}
        successful_outputs: dict[str, object] = {}
        failed_models: set[str] = set()
        skipped_models: set[str] = set()

        for model in ordered_models:
            blocked_by = [dependency for dependency in model.depends_on if dependency in failed_models]
            if blocked_by:
                failed_models.add(model.name)
                outputs[model.name] = ModelError(f"Skipped because upstream models failed: {blocked_by}")
                continue

            rendered, skip_state = render_prompt(
                model.source,
                successful_outputs,
                promptdata=promptdata,
                prompt_skipped_models=skipped_models,
            )

            if skip_state.skip_value is not None:
                outputs[model.name] = skip_state.skip_value
                successful_outputs[model.name] = skip_state.skip_value
                skipped_models.add(model.name)
                continue

            if model.promptfiles_used:
                if not promptfiles:
                    outputs[model.name] = ModelError(
                        f"Model '{model.name}' requires promptfiles, but the browser runner does not support file-backed Gemini inputs yet."
                    )
                    failed_models.add(model.name)
                    continue

                missing = [name for name in model.promptfiles_used if name not in promptfiles]
                if missing:
                    outputs[model.name] = ModelError(
                        f"Missing promptfiles for model '{model.name}': {', '.join(missing)}"
                    )
                    failed_models.add(model.name)
                    continue

                outputs[model.name] = ModelError(
                    f"Model '{model.name}' uses promptfiles, which are not yet supported by the browser Gemini runner."
                )
                failed_models.add(model.name)
                continue

            llm_output = await _call_gemini(
                rendered,
                api_key=api_key,
                model=window.localStorage.getItem("pbt.geminiModel") or _GEMINI_DEFAULT_MODEL,
            )

            if model.config.get("output_format", "text") == "json":
                parsed = _parse_json_output(llm_output)
                outputs[model.name] = parsed
                successful_outputs[model.name] = parsed
            else:
                outputs[model.name] = llm_output
                successful_outputs[model.name] = llm_output

        serialised, errors = _serialise(outputs)
        if select:
            serialised = {name: value for name, value in serialised.items() if name in select}
            errors = [error for error in errors if error.split(":", 1)[0] in select]
        return json.dumps({"outputs": serialised, "errors": errors})
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return json.dumps({"outputs": {}, "errors": [str(exc)]})


async def _init_runtime() -> None:
    gemini_sdk_status = "fallback"
    gemini_sdk_message = "Using browser fetch for Gemini."

    _dispatch_status("Preparing browser Python runtime…")

    try:
        import micropip

        _dispatch_status("Installing Gemini Python dependency…")
        await micropip.install("google-genai==1.66.0")
        gemini_sdk_status = "installed"
        gemini_sdk_message = "google-genai installed; runtime still uses browser fetch for requests."
    except Exception:
        gemini_sdk_message = "google-genai install failed; falling back to browser fetch."

    bridge = Object.new()
    bridge.runDag = ffi.create_proxy(_run_dag)
    bridge.runtimeInfo = ffi.to_js(
        {
            "geminiSdkStatus": gemini_sdk_status,
            "geminiSdkMessage": gemini_sdk_message,
        }
    )
    window.__pbtPyBridge = bridge
    _dispatch_status("PyScript bridge ready.")


asyncio.create_task(_init_runtime())
