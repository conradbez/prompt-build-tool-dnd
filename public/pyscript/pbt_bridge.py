import asyncio
import inspect
import json
import re
import traceback

from js import CustomEvent, Object
from pyodide.http import pyfetch
from pyscript import ffi, window

_JSON_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)
_storage_backend = None
_GEMINI_DEFAULT_MODEL = "gemini-3-flash-preview"
_OPENAI_DEFAULT_MODEL = "gpt-5.4-mini"
_ANTHROPIC_DEFAULT_MODEL = "claude-4-6-sonnet"
_ANTHROPIC_VERSION = "2023-06-01"

# In-browser local inference via WebLLM (WebGPU). No API key or network round
# trip once the quantised weights are cached in the browser's Cache API.
#
# Three size tiers, chosen against an 8 GB Apple-silicon budget: Chrome caps a
# single WebGPU buffer at ~4.29 GB there, and the OS plus the browser itself
# want several GB, so ~3.4 GB of weights is the practical ceiling. Download
# figures assume roughly 3 MB/s.
_LOCAL_MODELS = {
    # ~195 MB download, 376 MB VRAM. Loads in under a minute; output quality is
    # poor, so this tier is for checking that a DAG is wired up, not for results.
    "local-small": "SmolLM2-360M-Instruct-q4f16_1-MLC",
    # ~1.9 GB download (5-10 min), 2.3 GB VRAM. The general-purpose default.
    "local-medium": "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    # ~2.4 GB download, 3.4 GB VRAM — the largest that still fits comfortably
    # under the 8 GB M1 ceiling.
    "local-large": "Phi-4-mini-instruct-q4f16_1-MLC",
}
_local_engine = None
_local_model = None
# WebLLM shares a single GPU context, so serialise concurrent DAG nodes rather
# than firing overlapping completions at one engine.
_local_lock = asyncio.Lock()


def _to_js(obj):
    """Convert a (possibly nested) Python dict to a real JS object.

    A plain ``to_js`` turns dicts into ``Map``s, whose keys WebLLM cannot read
    as properties; ``Object.fromEntries`` gives it ``{...}`` instead.
    """
    return ffi.to_js(obj, dict_converter=Object.fromEntries)


def _dispatch_status(message: str) -> None:
    detail = ffi.to_js({"detail": {"message": message}})
    event = CustomEvent.new("pbt:pyscript-status", detail)
    window.dispatchEvent(event)


def _dispatch_local_progress(message: str, progress: float) -> None:
    """Report local-model download/load progress to the UI.

    Emitted on its own event so the toolbar can show it even after the
    PyScript bridge itself has finished initialising.
    """
    detail = ffi.to_js({"detail": {"message": message, "progress": progress}})
    event = CustomEvent.new("pbt:local-progress", detail)
    window.dispatchEvent(event)


async def _ensure_local_engine(model: str):
    """Lazily create (and cache) a WebLLM engine for ``model``.

    First use downloads 1-4 GB of quantised weights from the HuggingFace CDN
    into the browser cache; subsequent uses are instant unless the cache was
    evicted under storage pressure.
    """
    global _local_engine, _local_model

    if _local_engine is not None and _local_model == model:
        return _local_engine

    if not hasattr(window.navigator, "gpu"):
        raise RuntimeError(
            "WebGPU is unavailable in this browser, so local models can't run. "
            "Use a WebGPU-enabled browser (Chrome/Edge, recent Firefox/Safari) "
            "or pick a hosted provider."
        )

    from pyscript.js_modules import webllm

    def on_progress(report):
        # report.text is a human-readable status; report.progress is 0..1.
        try:
            text = report.text
        except Exception:
            text = "Loading local model…"
        try:
            progress = float(report.progress)
        except Exception:
            progress = 0.0
        _dispatch_local_progress(text, progress)

    _dispatch_local_progress(f"Preparing local model {model}…", 0.0)
    cfg = _to_js({"initProgressCallback": ffi.create_proxy(on_progress)})
    engine = await webllm.CreateMLCEngine(model, cfg)

    _local_engine = engine
    _local_model = model
    _dispatch_local_progress(f"Local model {model} ready.", 1.0)
    return engine


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


def _model_for_provider(provider: str) -> str:
    if provider == "gemini":
        return window.localStorage.getItem("pbt.geminiModel") or _GEMINI_DEFAULT_MODEL
    if provider == "openai":
        return window.localStorage.getItem("pbt.openaiModel") or _OPENAI_DEFAULT_MODEL
    if provider == "anthropic":
        return window.localStorage.getItem("pbt.anthropicModel") or _ANTHROPIC_DEFAULT_MODEL
    if provider in _LOCAL_MODELS:
        # Per-tier override, e.g. pbt.localModel.local-large, then a blanket
        # pbt.localModel override, then the tier's built-in default.
        return (
            window.localStorage.getItem(f"pbt.localModel.{provider}")
            or window.localStorage.getItem("pbt.localModel")
            or _LOCAL_MODELS[provider]
        )
    raise ValueError(f"Unsupported browser provider: {provider}.")


async def _send_json_request(url: str, headers: dict[str, str], body: dict) -> dict:
    response = await pyfetch(
        url,
        method="POST",
        headers=headers,
        body=json.dumps(body),
    )

    try:
        payload = await response.json()
    except Exception:
        payload = {}

    if not response.ok:
        message = payload.get("error", {}).get("message") or payload.get("error", {}).get("details")
        if not message:
            message = f"HTTP {response.status}"
        raise RuntimeError(str(message))

    return payload


async def _call_llm(provider: str, prompt: str, api_key: str) -> str:
    if provider in _LOCAL_MODELS:
        model = _model_for_provider(provider)
        async with _local_lock:
            engine = await _ensure_local_engine(model)
            request = _to_js(
                {"messages": [{"role": "user", "content": prompt}]}
            )
            reply = await engine.chat.completions.create(request)
        # Returns are JsProxy objects — attribute access works, subscripting
        # by string does not.
        text = reply.choices[0].message.content
        if text:
            return text
        raise RuntimeError("Local model returned an empty response.")

    if provider == "gemini":
        payload = await _send_json_request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{_model_for_provider(provider)}:generateContent?key={api_key}",
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
        if text:
            return text
        raise RuntimeError("Gemini returned an empty response.")

    if provider == "openai":
        payload = await _send_json_request(
            "https://api.openai.com/v1/responses",
            {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            {
                "model": _model_for_provider(provider),
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

    if provider == "anthropic":
        payload = await _send_json_request(
            "https://api.anthropic.com/v1/messages",
            {
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
            },
            {
                "model": _model_for_provider(provider),
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
        if text:
            return text
        raise RuntimeError("Anthropic returned an empty response.")

    raise ValueError(f"Unsupported browser provider: {provider}.")


async def _run_dag(payload_json: str) -> str:
    try:
        import pbt

        payload = json.loads(payload_json)
        provider = payload.get("provider") or "gemini"
        api_key = payload.get("apiKey")
        if provider not in {"gemini", "openai", "anthropic"} | set(_LOCAL_MODELS):
            raise ValueError(
                "The PyScript runtime currently supports Gemini, OpenAI, Anthropic, and local models."
            )
        if provider not in _LOCAL_MODELS and not api_key:
            raise ValueError(f"An API key is required for the {provider} PyScript runner.")
        if payload.get("promptfiles"):
            return json.dumps({
                "outputs": {},
                "errors": ["Promptfiles are not supported by the browser pbt runner yet."],
            })

        models_dict = {
            node["name"]: node["source"]
            for node in (payload.get("nodes") or [])
        }

        async def llm_call(prompt: str, files=None, config=None) -> str:
            if files:
                raise ValueError("Promptfiles are not supported by the browser pbt runner yet.")

            output = await _call_llm(provider, prompt, api_key)
            if config and config.get("output_format", "text") == "json":
                _parse_json_output(output)
            return output

        if not inspect.iscoroutinefunction(getattr(pbt, "async_run", None)):
            raise RuntimeError("Loaded prompt-build-tool does not expose async pbt.async_run().")

        outputs = await pbt.async_run(
            models_from_dict=models_dict,
            select=payload.get("select") or None,
            llm_call=llm_call,
            verbose=False,
            promptdata=payload.get("promptdata") or None,
            validation_dir=None,
            storage_backend=_storage_backend,
        )

        serialised, errors = _serialise(outputs)
        return json.dumps({"outputs": serialised, "errors": errors}, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return json.dumps({"outputs": {}, "errors": [str(exc)]}, ensure_ascii=False)


async def _init_runtime() -> None:
    global _storage_backend
    _dispatch_status("Preparing browser Python runtime…")

    try:
        import pbt
        from pbt.storage import MemoryStorageBackend
        _storage_backend = MemoryStorageBackend()
    except Exception as exc:
        window.__pbtPyBridgeError = str(exc)
        _dispatch_status(f"PyScript bootstrap failed: {exc}")
        return

    version = getattr(pbt, "__version__", "unknown")
    is_async = inspect.iscoroutinefunction(getattr(pbt, "run", None))
    print(f"[pyscript] pbt version={version} run_async={is_async}")
    _dispatch_status(f"PyScript bridge ready. pbt {version}. async run={is_async}")

    bridge = Object.new()
    bridge.runDag = ffi.create_proxy(_run_dag)
    window.__pbtPyBridge = bridge


asyncio.create_task(_init_runtime())
