from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from typing import Any, Optional

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult


def _fetch(url: str, *, timeout_s: float = 12.0, user_agent: str = "Mozilla/5.0") -> str:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
        data = resp.read()
    try:
        return data.decode("utf-8", errors="replace")
    except Exception:
        return data.decode(errors="replace")


def _strip_html(s: str) -> str:
    s = re.sub(r"(?is)<script.*?>.*?</script>", "", s)
    s = re.sub(r"(?is)<style.*?>.*?</style>", "", s)
    s = re.sub(r"(?is)<.*?>", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _fetch_json(url: str, *, headers: dict[str, str], timeout_s: float = 12.0) -> Any:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
        data = resp.read()
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:
        text = data.decode(errors="replace")
    return json.loads(text)


@tool(
    name="web_search",
    description="Search the web (Bing) and return top results (title/url/snippet) as JSON text.",
)
async def web_search(
    *,
    query: str,
    limit: int = 5,
    region: Optional[str] = None,
) -> dict[str, Any]:
    q = str(query or "").strip()
    if not q:
        raise ValueError("query is required")

    limit = max(1, min(10, int(limit or 5)))
    market = (region or os.getenv("BING_SEARCH_MARKET") or "zh-CN").strip() or "zh-CN"

    # Preferred: Bing Web Search API (requires env BING_SEARCH_KEY).
    api_key = (os.getenv("BING_SEARCH_KEY") or os.getenv("BING_API_KEY") or "").strip()
    endpoint = (os.getenv("BING_SEARCH_ENDPOINT") or "https://api.bing.microsoft.com/v7.0/search").strip()

    results: list[dict[str, str]] = []
    used = "bing_api" if api_key else "bing_html"

    if api_key:
        url = endpoint.rstrip("/") + "/search?" + urllib.parse.urlencode({"q": q, "count": limit, "mkt": market})
        data = _fetch_json(url, headers={"Ocp-Apim-Subscription-Key": api_key})
        items = (data.get("webPages") or {}).get("value") or []
        for it in items[:limit]:
            title = str(it.get("name") or "").strip()
            href = str(it.get("url") or "").strip()
            snippet = str(it.get("snippet") or "").strip()
            if not href or not title:
                continue
            results.append({"title": title, "url": href, "snippet": snippet})
    else:
        # Fallback: scrape Bing HTML (best-effort; no key).
        # Note: HTML structure may change; keep regex conservative.
        url = "https://www.bing.com/search?" + urllib.parse.urlencode({"q": q, "count": limit, "setlang": market})
        html = _fetch(url)

        # Example:
        # <li class="b_algo"><h2><a href="URL" ...>Title</a></h2> ... <p>Snippet</p>
        for m in re.finditer(r'(?is)<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>(.*?)</li>', html):
            block = m.group(1)
            m2 = re.search(r'(?is)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block)
            if not m2:
                continue
            href = urllib.parse.unquote(m2.group(1))
            title = _strip_html(m2.group(2))
            m3 = re.search(r"(?is)<p[^>]*>(.*?)</p>", block)
            snippet = _strip_html(m3.group(1)) if m3 else ""
            if not href or not title:
                continue
            results.append({"title": title, "url": href, "snippet": snippet})
            if len(results) >= limit:
                break

    content = json.dumps({"engine": used, "query": q, "market": market, "results": results}, ensure_ascii=False)
    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": content,
                "mime": "application/json; charset=utf-8",
                "meta": {"query": q, "limit": limit, "market": market, "engine": used},
            }
        ],
        meta={"query": q, "limit": limit, "market": market, "engine": used},
    ).model_dump(mode="json")
