"""
Minimal LLM client for the mind-map runner.

One function, ``make_llm_call``, returns a callable bound to a provider and an
optional API key. It is deliberately small: text prompts only — no file inputs,
no template node types, no in-browser models. Those main-branch features are
intentionally left out.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Optional

ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def make_llm_call(api_key: Optional[str] = None, provider: str = "gemini") -> Callable[..., str]:
    """Return an ``llm_call(prompt, files=None, config=None)`` bound to a provider.

    The key is taken from ``api_key`` (sent from the UI) or, if absent, the
    matching environment variable on the server.
    """

    def llm_call(prompt: str, files: Any = None, config: Any = None) -> str:
        key = api_key or os.environ.get(ENV_KEYS[provider])
        if not key:
            raise RuntimeError(
                f"No API key for '{provider}'. Enter one in the toolbar or set "
                f"{ENV_KEYS[provider]} on the server."
            )

        if provider == "gemini":
            from google import genai

            client = genai.Client(api_key=key)
            resp = client.models.generate_content(
                model=os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
                contents=[prompt],
            )
            return resp.text or ""

        if provider == "openai":
            import openai

            client = openai.OpenAI(api_key=key)
            resp = client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                messages=[{"role": "user", "content": prompt}],
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
