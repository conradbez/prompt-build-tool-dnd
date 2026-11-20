"""
Minimal LLM client for the mind-map runner.

One function, ``make_llm_call``, returns promptmap's own LiteLLM backend
(`promptmap.llm.litellm_llm_call`) bound to the run's provider, model and the
API key the UI sent — so every provider, attachments and a bullet's own
``config(model=…)`` are handled by promptmap. promptmap hands it the files a
bullet declared (see `files.py`), so an attachment on a bullet goes to the model
along with that bullet's prompt.

What is left here is what promptmap does not do: classifier-judged tests, and
the rule that the key is only ever the one the request carried.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

import promptmap
from promptmap.llm import litellm_llm_call
from promptmap_extra_model_kinds.models import MODEL_ENV, model_name


def _classify(prompt: str, config: dict, settings: dict) -> str:
    """A classifier-judged test: P(yes) for the question above ``---`` about the
    material below it, returned as the verdict JSON every test bullet gives.

    The key, like the LLM's, is only ever what the UI sent: promptmap would otherwise
    fall back to the server's ``TYPESAFE_API_KEY``. An empty key is still a
    valid call — a local Ollaya needs none.
    """
    from promptmap.classifier import parse_threshold, split_question

    question, state = split_question(prompt)
    classify_call = promptmap.systemone_classifier(
        model=settings.get("model") or None,
        base_url=settings.get("baseUrl") or None,
        api_key=settings.get("apiKey") or "",
    )
    p_yes = float(classify_call(state, question))
    threshold = parse_threshold(config.get("threshold"))
    return json.dumps({"pass": p_yes >= threshold, "p_yes": round(p_yes, 4), "threshold": threshold})


def make_llm_call(
    api_key: Optional[str] = None,
    provider: str = "gemini",
    classifier: Optional[dict] = None,
    model: Optional[str] = None,
) -> Callable[..., Any]:
    """Return an ``llm_call(prompt, files=None, config=None)`` bound to a provider.

    The key is only ever ``api_key`` (sent from the UI) — the server's own
    environment keys are never used, so a public deploy can't spend them.
    ``classifier`` holds the settings for classifier-judged tests. ``model`` is
    the person's own choice from Settings; without one the server's default
    for the provider (`model_name`) answers. A bullet's own ``config(model=…)``
    beats both — promptmap's backend reads it.

    The returned function is a plain wrapper, deliberately without the
    backend's ``cache_identity``: that would put the model in the cache key,
    and this server keeps cached answers when the model changes (see
    `main.MODEL_KEY`).
    """
    default = model or (model_name(provider) if provider in MODEL_ENV else "")
    backend = litellm_llm_call(provider, default, api_key=api_key) if api_key else None

    def llm_call(prompt: str, files: Any = None, config: Any = None) -> Any:
        config = config or {}
        if config.get("judge") == "classifier":
            return _classify(prompt, config, classifier or {})
        if backend is None:
            raise RuntimeError(f"No API key for '{provider}'. Enter one in settings.")
        for f in files or []:
            if hasattr(f, "seek"):
                f.seek(0)  # promptmap's backend reads without rewinding a shared handle
        return backend(prompt, files=files, config=config)

    return llm_call
