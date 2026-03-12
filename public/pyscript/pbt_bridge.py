import asyncio
import json
import re
import traceback

from js import CustomEvent, Object, XMLHttpRequest
from pyscript import ffi, window

_JSON_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)
_GEMINI_DEFAULT_MODEL = "gemini-2.0-flash"
_OPENAI_DEFAULT_MODEL = "gpt-5-mini"
_ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-20250514"
_ANTHROPIC_VERSION = "2023-06-01"


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
    from pbt import ModelError, ModelStatus

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


def _send_json_request(url: str, headers: dict[str, str], body: dict) -> dict:
    xhr = XMLHttpRequest.new()
    xhr.open("POST", url, False)
    for header_name, header_value in headers.items():
        xhr.setRequestHeader(header_name, header_value)
    xhr.send(json.dumps(body))

    try:
        payload = json.loads(xhr.responseText or "{}")
    except Exception:
        payload = {}

    if xhr.status < 200 or xhr.status >= 300:
        message = payload.get("error", {}).get("message") or payload.get("error", {}).get("details")
        if not message:
            message = xhr.responseText or f"HTTP {xhr.status}"
        raise RuntimeError(str(message))

    return payload


def _call_gemini(prompt: str, api_key: str, model: str) -> str:
    payload = _send_json_request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
        {"Content-Type": "application/json"},
        {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ]
        },
    )

    candidates = payload.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "".join(part.get("text", "") for part in parts)
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text


def _call_openai(prompt: str, api_key: str, model: str) -> str:
    payload = _send_json_request(
        "https://api.openai.com/v1/responses",
        {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        {
            "model": model,
            "input": prompt,
        },
    )

    if payload.get("output_text"):
        return payload["output_text"]

    output = payload.get("output") or []
    for item in output:
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                return content["text"]

    raise RuntimeError("OpenAI returned an empty response.")


def _call_anthropic(prompt: str, api_key: str, model: str) -> str:
    payload = _send_json_request(
        "https://api.anthropic.com/v1/messages",
        {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": _ANTHROPIC_VERSION,
        },
        {
            "model": model,
            "max_tokens": 4096,
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        },
    )

    content = payload.get("content") or []
    text = "".join(part.get("text", "") for part in content if part.get("type") == "text")
    if not text:
        raise RuntimeError("Anthropic returned an empty response.")
    return text


def _call_llm(provider: str, prompt: str, api_key: str) -> str:
    if provider == "gemini":
        return _call_gemini(
            prompt,
            api_key=api_key,
            model=window.localStorage.getItem("pbt.geminiModel") or _GEMINI_DEFAULT_MODEL,
        )

    if provider == "openai":
        return _call_openai(
            prompt,
            api_key=api_key,
            model=window.localStorage.getItem("pbt.openaiModel") or _OPENAI_DEFAULT_MODEL,
        )

    if provider == "anthropic":
        return _call_anthropic(
            prompt,
            api_key=api_key,
            model=window.localStorage.getItem("pbt.anthropicModel") or _ANTHROPIC_DEFAULT_MODEL,
        )

    raise ValueError(f"Unsupported browser provider: {provider}.")


async def _run_dag(payload_json: str) -> str:
    try:
        import pbt
        from pbt.storage import MemoryStorageBackend

        payload = json.loads(payload_json)
        provider = payload.get("provider") or "gemini"
        api_key = payload.get("apiKey")
        if provider not in {"gemini", "openai", "anthropic"}:
            raise ValueError("The PyScript runtime currently supports Gemini, OpenAI, and Anthropic.")
        if not api_key:
            raise ValueError(f"An API key is required for the {provider} PyScript runner.")

        nodes = payload.get("nodes") or []
        models_dict = {
            node["name"]: _inline_template_source(node["source"]) if node.get("isTemplate") else node["source"]
            for node in nodes
        }
        promptdata = payload.get("promptdata") or None
        select = payload.get("select") or None
        if payload.get("promptfiles"):
            return json.dumps({
                "outputs": {},
                "errors": ["Promptfiles are not supported by the browser pbt runner yet."],
            })

        def llm_call(prompt: str, files=None, config=None) -> str:
            if files:
                raise ValueError("Promptfiles are not supported by the browser pbt runner yet.")

            output = _call_llm(provider, prompt, api_key)
            if config and config.get("output_format", "text") == "json":
                _parse_json_output(output)
            return output

        outputs = pbt.run(
            models_from_dict=models_dict,
            select=select,
            llm_call=llm_call,
            verbose=False,
            promptdata=promptdata,
            validation_dir=None,
            storage_backend=MemoryStorageBackend(),
        )

        serialised, errors = _serialise(outputs)
        if select:
            selected_set = set(select)
            serialised = {name: value for name, value in serialised.items() if name in selected_set}
            errors = [error for error in errors if error.split(":", 1)[0] in selected_set]
        return json.dumps({"outputs": serialised, "errors": errors})
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return json.dumps({"outputs": {}, "errors": [str(exc)]})


async def _init_runtime() -> None:
    gemini_sdk_status = "fallback"
    gemini_sdk_message = "Using browser fetch for provider requests."

    _dispatch_status("Preparing browser Python runtime…")

    try:
        import pbt  # noqa: F401
        gemini_sdk_status = "installed"
        gemini_sdk_message = "prompt-build-tool wheel loaded via PyScript packages; provider requests use browser fetch."
    except Exception as exc:
        gemini_sdk_message = f"PyScript bootstrap failed: {exc}"
        window.__pbtPyBridgeError = str(exc)
        _dispatch_status(gemini_sdk_message)
        return

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
