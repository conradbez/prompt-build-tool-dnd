"""
Minimal LLM client for the mind-map runner.

One function, ``make_llm_call``, returns a callable bound to a provider and the
API key the UI sent. Every provider goes through LiteLLM — the backend promptmap
itself uses (`promptmap.llm`) — so one code path handles them all, attachments
and JSON mode included. promptmap hands it the files a bullet declared (see
`files.py`), so an attachment on a bullet goes to the model along with that
bullet's prompt.

Not `promptmap.llm.litellm_llm_call` itself: that reads provider keys from the
environment, and this server never spends its own — the key is only ever the
one the request carried.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
from typing import Any, Callable, Optional

import promptmap
from promptmap.llm import litellm_model, quiet_litellm
from promptmap_extra_model_kinds.models import MODEL_ENV, model_name

# Anthropic requires a cap on the reply; LiteLLM's default is lower than ours was.
ANTHROPIC_MAX_TOKENS = 4096


def _read_named_files(files: Any) -> list[tuple[bytes, str, str]]:
    """Read promptmap's file objects into (bytes, mime type, file name) triples."""
    out: list[tuple[bytes, str, str]] = []
    for f in files or []:
        data = f.read() if hasattr(f, "read") else bytes(f)
        if hasattr(f, "seek"):
            f.seek(0)  # a file may be shared by several models in one run
        name = os.path.basename(getattr(f, "name", "") or "")
        out.append((data, _detect_mime(data, name), name))
    return out


def _content(prompt: str, files: list[tuple[bytes, str, str]]) -> str | list[dict]:
    """The user message's content: the prompt alone, or OpenAI-style parts —
    images as `image_url`, text inlined, everything else (PDFs first of all) as
    a `file` part. LiteLLM translates these for each provider."""
    if not files:
        return prompt
    parts: list[dict] = []
    for i, (data, mime, name) in enumerate(files, 1):
        name = name or f"file-{i}"
        url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
        if mime.startswith("image/"):
            parts.append({"type": "image_url", "image_url": {"url": url}})
        elif mime.startswith("text/") or mime in ("application/json", "application/xml"):
            text = data.decode("utf-8", errors="replace")
            parts.append({"type": "text", "text": f"<file name={name!r}>\n{text}\n</file>"})
        else:
            parts.append({"type": "file", "file": {"filename": name, "file_data": url}})
    parts.append({"type": "text", "text": prompt})
    return parts


def _detect_mime(data: bytes, name: str = "") -> str:
    """Sniff the common cases, then fall back to the file extension."""
    if data[:4] == b"%PDF":
        return "application/pdf"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    guessed = mimetypes.guess_type(name)[0] if name else None
    if guessed:
        return guessed
    try:
        data.decode("utf-8")
        return "text/plain"
    except UnicodeDecodeError:
        return "application/octet-stream"


def _wants_json(config: Any) -> bool:
    """True when the bullet declared ``config(output_format="json")``.

    promptmap validates the answer either way — it parses the response and fails the
    model if it will not parse. This is the other half: where a provider has a
    JSON mode, turn it on, so the model is *made* to comply rather than only
    checked afterwards. Anthropic has no such mode; there the instruction in the
    prompt is the whole of it.
    """
    return bool(config) and config.get("output_format") == "json"


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
    beats both — promptmap's standard key, the one its LiteLLM backend reads.
    """
    default = model or (model_name(provider) if provider in MODEL_ENV else "")

    def llm_call(prompt: str, files: Any = None, config: Any = None) -> promptmap.LLMResult | str:
        config = config or {}
        if config.get("judge") == "classifier":
            return _classify(prompt, config, classifier or {})
        if not api_key:
            raise RuntimeError(f"No API key for '{provider}'. Enter one in settings.")

        options: dict[str, Any] = {}
        if _wants_json(config) and provider != "anthropic":
            # OpenAI's JSON mode refuses a prompt that never says "JSON"; the
            # server appends that instruction to every JSON bullet, so it does.
            options["response_format"] = {"type": "json_object"}
        if provider == "anthropic":
            options["max_tokens"] = ANTHROPIC_MAX_TOKENS
        response = quiet_litellm().completion(
            model=litellm_model(provider, str(config.get("model") or default)),
            api_key=api_key,
            messages=[{"role": "user", "content": _content(prompt, _read_named_files(files))}],
            **options,
        )
        usage = getattr(response, "usage", None)
        return promptmap.LLMResult(
            response.choices[0].message.content or "",
            spent_tokens=getattr(usage, "total_tokens", None),
        )

    return llm_call
