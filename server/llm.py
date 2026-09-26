"""
Minimal LLM client for the mind-map runner.

One function, ``make_llm_call``, returns a callable bound to a provider and an
optional API key. pbt hands it the files a bullet declared (see `files.py`), so
an attachment on a bullet goes to the model along with that bullet's prompt.
"""

from __future__ import annotations

import json
import mimetypes
import os
from typing import Any, Callable, Optional

ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

# The model each provider runs, overridable per deployment. Shared with the
# agent bullets (`agent_exec.py`), so both kinds answer with the same model.
MODEL_ENV = {
    "gemini": ("GEMINI_MODEL", "gemini-3.6-flash"),
    "openai": ("OPENAI_MODEL", "gpt-4o-mini"),
    "anthropic": ("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
}


def model_name(provider: str) -> str:
    """The model id this server uses for *provider*."""
    var, default = MODEL_ENV[provider]
    return os.environ.get(var, default)


def _read_files(files: Any) -> list[tuple[bytes, str]]:
    """Read pbt's file objects into (bytes, mime type) pairs."""
    out: list[tuple[bytes, str]] = []
    for f in files or []:
        data = f.read() if hasattr(f, "read") else bytes(f)
        if hasattr(f, "seek"):
            f.seek(0)  # a file may be shared by several models in one run
        out.append((data, _detect_mime(data, getattr(f, "name", ""))))
    return out


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

    pbt validates the answer either way — it parses the response and fails the
    model if it will not parse. This is the other half: where a provider has a
    JSON mode of its own, turn it on, so the model is *made* to comply rather
    than only checked afterwards. Anthropic has no such mode; there the
    instruction in the prompt is the whole of it.
    """
    return bool(config) and config.get("output_format") == "json"


def _is_template(config: Any) -> bool:
    """True for nodes the editor marked as ``model_type="template"``.

    pbt has no model_type semantics of its own — it parses the directive into
    ``model.config`` and otherwise runs the node like any other prompt — so
    each runner honours it in its own ``llm_call``. Without this a template
    node would be sent to the LLM and answer the text instead of passing it on.
    """
    return bool(config) and config.get("model_type") == "template"


def _classify(prompt: str, config: dict, settings: dict) -> str:
    """A classifier-judged test: P(yes) for the question above ``---`` about the
    material below it, returned as the verdict JSON every test bullet gives.

    The key, like the LLM's, is only ever what the UI sent: pbt would otherwise
    fall back to the server's ``TYPESAFE_API_KEY``. An empty key is still a
    valid call — a local Ollaya needs none.
    """
    import pbt
    from pbt.classifier import parse_threshold, split_question

    question, state = split_question(prompt)
    classify_call = pbt.systemone_classifier(
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
) -> Callable[..., str]:
    """Return an ``llm_call(prompt, files=None, config=None)`` bound to a provider.

    The key is only ever ``api_key`` (sent from the UI) — the server's own
    environment keys are never used, so a public deploy can't spend them.
    ``classifier`` holds the settings for classifier-judged tests.
    """

    def llm_call(prompt: str, files: Any = None, config: Any = None) -> str:
        if config and config.get("judge") == "classifier":
            return _classify(prompt, config, classifier or {})
        if _is_template(config):
            # ref()/promptdata() are already substituted, so the rendered
            # prompt *is* the output. Stripped because the injected
            # {{ config(...) }} line renders to an empty first line.
            return prompt.strip()

        key = api_key
        if not key:
            raise RuntimeError(f"No API key for '{provider}'. Enter one in settings.")

        file_data = _read_files(files)

        if provider == "gemini":
            from google import genai
            from google.genai import types

            client = genai.Client(api_key=key)
            parts: list = [
                types.Part.from_bytes(data=data, mime_type=mime) for data, mime in file_data
            ]
            parts.append(prompt)
            resp = client.models.generate_content(
                model=model_name("gemini"),
                contents=parts,
                config=types.GenerateContentConfig(response_mime_type="application/json")
                if _wants_json(config)
                else None,
            )
            return resp.text or ""

        if file_data:
            # Only the Gemini path builds multimodal parts so far. Say so
            # rather than quietly dropping the attachment from the prompt.
            raise RuntimeError(
                f"Attachments are only wired up for Gemini; '{provider}' received "
                f"{len(file_data)} file(s) it cannot send."
            )

        if provider == "openai":
            import openai

            client = openai.OpenAI(api_key=key)
            resp = client.chat.completions.create(
                model=model_name("openai"),
                messages=[{"role": "user", "content": prompt}],
                # JSON mode refuses a prompt that never says "JSON"; the server
                # appends that instruction to every JSON bullet, so it does.
                **({"response_format": {"type": "json_object"}} if _wants_json(config) else {}),
            )
            return resp.choices[0].message.content or ""

        if provider == "anthropic":
            import anthropic

            client = anthropic.Anthropic(api_key=key)
            msg = client.messages.create(
                model=model_name("anthropic"),
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(
                block.text for block in msg.content if getattr(block, "type", None) == "text"
            )

        raise ValueError(f"Unsupported provider: {provider}")

    return llm_call
