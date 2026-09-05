"""
Minimal LLM client for the mind-map runner.

One function, ``make_llm_call``, returns a callable bound to a provider and an
optional API key. pbt hands it the files a bullet declared (see `files.py`), so
an attachment on a bullet goes to the model along with that bullet's prompt.
"""

from __future__ import annotations

import mimetypes
import os
from typing import Any, Callable, Optional

ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


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


def make_llm_call(api_key: Optional[str] = None, provider: str = "gemini") -> Callable[..., str]:
    """Return an ``llm_call(prompt, files=None, config=None)`` bound to a provider.

    The key is taken from ``api_key`` (sent from the UI) or, if absent, the
    matching environment variable on the server.
    """

    def llm_call(prompt: str, files: Any = None, config: Any = None) -> str:
        if _is_template(config):
            # ref()/promptdata() are already substituted, so the rendered
            # prompt *is* the output. Stripped because the injected
            # {{ config(...) }} line renders to an empty first line.
            return prompt.strip()

        key = api_key or os.environ.get(ENV_KEYS[provider])
        if not key:
            raise RuntimeError(
                f"No API key for '{provider}'. Enter one in the toolbar or set "
                f"{ENV_KEYS[provider]} on the server."
            )

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
                model=os.environ.get("GEMINI_MODEL", "gemini-3.6-flash"),
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
                model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
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
                model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(
                block.text for block in msg.content if getattr(block, "type", None) == "text"
            )

        raise ValueError(f"Unsupported provider: {provider}")

    return llm_call
