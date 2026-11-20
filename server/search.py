"""
Web search for search bullets, on the run's own provider and key.

promptmap-extra-model-kinds ships a grounded-search RAG kind per provider —
``rag_gemini_search``, ``rag_openai_search``, ``rag_anthropic_search`` — so a
search bullet searches through the provider the person already chose, with the
key they sent. OpenRouter has none, so its runs fall back to Brave, which needs
``BRAVE_API_KEY`` on the server.

The key reaches them as a promptmap *secret* — run-scoped, never rendered,
cached or stored — under the name each kind reads it by. The kinds look in the
run's secrets before the environment, so concurrent runs each search with their
own key and the server's environment is never consulted for a provider key.
"""

from __future__ import annotations

from typing import Optional

#: The RAG function a search bullet calls, by run provider.
FUNCTIONS = {
    "gemini": "rag_gemini_search",
    "openai": "rag_openai_search",
    "anthropic": "rag_anthropic_search",
}
FALLBACK = "rag_brave_search"

#: The secret each search kind reads its key from, by run provider.
SECRET_NAMES = {
    "gemini": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def function_for(provider: str) -> str:
    """The `rag_…` function a search bullet calls on this provider."""
    return FUNCTIONS.get(provider, FALLBACK)


def secrets_for(provider: str, api_key: Optional[str]) -> dict[str, str]:
    """The run's secrets: its key, named for the search kind of its provider."""
    name = SECRET_NAMES.get(provider)
    return {name: api_key} if name and api_key else {}
