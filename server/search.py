"""
Web search for search bullets, on the run's own provider and key.

promptmap-extra-model-kinds ships a grounded-search RAG kind per provider —
``rag_gemini_search``, ``rag_openai_search``, ``rag_anthropic_search`` — so a
search bullet searches through the provider the person already chose, with the
key they sent. OpenRouter has none, so its runs fall back to Brave, which needs
``BRAVE_API_KEY`` on the server.

Those kinds read their key from the environment, and this server never spends
its own provider keys. So each is pointed at the key bound for the current run
(a context var, set around ``promptmap.async_run`` the way `agent_exec.use_run`
binds the agent's): concurrent runs each see their own, and a run with no key
for that provider fails the search rather than falling back to the server's.
"""

from __future__ import annotations

import contextvars
from typing import Optional

import anthropic as _anthropic
from promptmap_extra_model_kinds import anthropic_search, gemini_search, openai_search

#: The RAG function a search bullet calls, by run provider.
FUNCTIONS = {
    "gemini": "rag_gemini_search",
    "openai": "rag_openai_search",
    "anthropic": "rag_anthropic_search",
}
FALLBACK = "rag_brave_search"

#: The environment variable each kind would otherwise read, by run provider.
_KEY_ENV = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

_run_key: contextvars.ContextVar[Optional[tuple[str, str]]] = contextvars.ContextVar(
    "search_run_key", default=None
)


def function_for(provider: str) -> str:
    """The `rag_…` function a search bullet calls on this provider."""
    return FUNCTIONS.get(provider, FALLBACK)


def use_key(provider: str, api_key: Optional[str]) -> contextvars.Token:
    """Bind this run's provider and key for the searches it makes."""
    return _run_key.set((provider, api_key or ""))


def reset_key(token: contextvars.Token) -> None:
    _run_key.reset(token)


def _key_for(env_name: str, rag: str) -> str:
    """The run's key, if it is the one *env_name* names — never the server's."""
    bound = _run_key.get()
    if bound and bound[1] and _KEY_ENV.get(bound[0]) == env_name:
        return bound[1]
    raise RuntimeError(
        f"rag_{rag}() searches with the key entered in settings, and this run has "
        f"no key for {env_name.split('_')[0].title()}."
    )


class _AnthropicOnRunKey:
    """The `anthropic` module as `anthropic_search` sees it, but for the
    client, which is built with the run's key instead of the SDK's env lookup."""

    def __getattr__(self, name: str):
        return getattr(_anthropic, name)

    def Anthropic(self, **kwargs):  # noqa: N802 — stands in for the class
        return _anthropic.Anthropic(api_key=_key_for("ANTHROPIC_API_KEY", "anthropic_search"), **kwargs)


gemini_search.api_key = _key_for
openai_search.api_key = _key_for
anthropic_search.anthropic = _AnthropicOnRunKey()
