"""
Web search for search bullets, via the Brave Search API.

Handed to promptmap as `rag_call`, which backs `return_list_RAG_results()` in a
search bullet's template. Needs BRAVE_API_KEY.

promptmap renders templates synchronously on the event loop, so a search holds
it for as long as the request takes — hence the timeout.
"""

from __future__ import annotations

import os
import re

import httpx

BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
MAX_RESULTS = 8
TIMEOUT = 15
# The `[name]` / `[/name]` lines promptmap wraps each `ref()` in — labels for an
# LLM, noise in a search query.
_REF_TAG = re.compile(r"^\[/?[\w-]+\]$", re.M)
# Brave marks the matched words in a snippet with <strong>.
_HTML_TAG = re.compile(r"</?\w+>")


def do_search(query: str) -> list[str]:
    """The top results for *query*, one `title / url / snippet` block each."""
    query = " ".join(_REF_TAG.sub("", query).split())
    if not query:
        return ["[Search skipped: the query was empty.]"]
    key = os.environ.get("BRAVE_API_KEY")
    if not key:
        raise RuntimeError("Web search is not configured on this server (no BRAVE_API_KEY).")
    try:
        resp = httpx.get(
            BRAVE_URL,
            # Brave caps a query at 400 characters.
            params={"q": query[:400], "count": MAX_RESULTS},
            headers={"Accept": "application/json", "X-Subscription-Token": key},
            timeout=TIMEOUT,
        )
    except httpx.TimeoutException:
        raise RuntimeError(f"Web search timed out after {TIMEOUT}s.") from None
    if resp.status_code != 200:
        raise RuntimeError(f"Web search failed ({resp.status_code}): {resp.text[:500]}")
    results = resp.json().get("web", {}).get("results", [])[:MAX_RESULTS]
    if not results:
        return [f"[No web results for: {query}]"]
    return [
        "\n".join(
            filter(None, [r.get("title", ""), r.get("url", ""), _HTML_TAG.sub("", r.get("description", ""))])
        )
        for r in results
    ]
