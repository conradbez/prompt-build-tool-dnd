"""
Which LLM each provider runs — shared by the agent kinds and the server's own
LLM client, so an agent bullet and a prompt bullet answer with the same model.
"""

from __future__ import annotations

import os
from typing import Mapping

ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

# The model each provider runs, overridable per deployment.
MODEL_ENV = {
    "gemini": ("GEMINI_MODEL", "gemini-3.6-flash"),
    "openai": ("OPENAI_MODEL", "gpt-4o-mini"),
    "anthropic": ("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
    "openrouter": ("OPENROUTER_MODEL", "deepseek/deepseek-v4.1-flash"),
}


def model_name(provider: str) -> str:
    """The model id this server uses for *provider*."""
    var, default = MODEL_ENV[provider]
    return os.environ.get(var, default)


def provider_key(secrets: Mapping[str, str], provider: str | None = None) -> tuple[str, str]:
    """The provider to call and its key, from the run's ``call.secrets``.

    Keys are named as in `ENV_KEYS`, so ``pbt run --secret OPENAI_API_KEY`` is
    all a standalone run needs. A *provider* the host chose must have its key;
    without one, the first provider whose key was passed is used.
    """
    if provider:
        key = secrets.get(ENV_KEYS.get(provider, ""), "")
        if not key:
            raise RuntimeError(f"No API key for '{provider}'. Enter one in settings.")
        return provider, key
    for name, var in ENV_KEYS.items():
        if secrets.get(var):
            return name, secrets[var]
    raise RuntimeError(
        "No API key for this run. Pass one of "
        + ", ".join(ENV_KEYS.values())
        + " (secrets={...} or --secret NAME)."
    )
