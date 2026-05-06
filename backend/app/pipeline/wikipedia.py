"""On-demand Wikipedia retrieval for the /verify pipeline.

When the pgvector corpus doesn't have strong evidence for a claim (max
similarity below `wikipedia_fallback_threshold`), we hit Wikipedia's REST API
for the top-K relevant article summaries, embed them, score them with the
same NLI model, and merge them into the evidence pool. Summaries are cached
by article title with a multi-day TTL because Wikipedia's lede paragraphs
change slowly.

I/O and parsing are split: `_parse_search_response` and `_parse_summary_response`
are pure helpers (easy to unit-test); the network functions just wrap them.
"""

from __future__ import annotations

import asyncio
import logging
import urllib.parse
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import numpy as np
from sqlalchemy.orm import Session

from app.config import Settings
from app.models.db import WikipediaCache
from app.pipeline.embedding import embed

logger = logging.getLogger(__name__)

_SEARCH_URL = "https://en.wikipedia.org/w/api.php"
_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary"
_USER_AGENT = "FactOrCap/0.1 (+https://github.com/) httpx"
_MIN_EXTRACT_LEN = 80


# ──────────────── pure parsers (unit-testable) ────────────────


def _parse_search_response(data: dict) -> list[str]:
    return [
        str(s.get("title", "")).strip()
        for s in data.get("query", {}).get("search", [])
        if s.get("title")
    ]


def _parse_opensearch_response(data: Any) -> list[str]:
    """opensearch returns [search_term, [titles], [descs], [urls]]."""
    if not isinstance(data, list) or len(data) < 2:
        return []
    titles = data[1]
    if not isinstance(titles, list):
        return []
    return [str(t).strip() for t in titles if t]


def _merge_titles(*lists: list[str], limit: int) -> list[str]:
    """Round-robin merge that preserves relative order within each input list
    and dedupes across them. Lets entity-prefix matches and full-text matches
    interleave so the highest-confidence hit from each strategy lands near
    the top of the merged list."""
    seen: set[str] = set()
    merged: list[str] = []
    iters = [list(reversed(lst)) for lst in lists]
    while any(iters) and len(merged) < limit:
        for src in iters:
            if not src:
                continue
            t = src.pop()
            if t and t not in seen:
                seen.add(t)
                merged.append(t)
                if len(merged) >= limit:
                    break
    return merged


def _parse_summary_response(data: dict, fallback_title: str) -> dict | None:
    if not isinstance(data, dict):
        return None
    if data.get("type") == "disambiguation":
        return None
    extract = (data.get("extract") or "").strip()
    if len(extract) < _MIN_EXTRACT_LEN:
        return None
    title = data.get("title") or fallback_title
    desktop = (data.get("content_urls") or {}).get("desktop") or {}
    page_url = desktop.get("page") or _wiki_url_for(title)
    return {"title": title, "extract": extract, "url": page_url}


def _wiki_url_for(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"


# ──────────────── network ────────────────


async def _fulltext_search(
    client: httpx.AsyncClient, query: str, limit: int
) -> list[str]:
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "format": "json",
        "srlimit": limit,
    }
    resp = await client.get(_SEARCH_URL, params=params)
    resp.raise_for_status()
    return _parse_search_response(resp.json())


async def _opensearch(
    client: httpx.AsyncClient, query: str, limit: int
) -> list[str]:
    params = {
        "action": "opensearch",
        "search": query,
        "limit": limit,
        "namespace": 0,
        "format": "json",
    }
    resp = await client.get(_SEARCH_URL, params=params)
    resp.raise_for_status()
    return _parse_opensearch_response(resp.json())


async def search_titles(query: str, limit: int = 5, timeout: float = 5.0) -> list[str]:
    """Run opensearch (entity-prefix matching) and full-text search in
    parallel, then round-robin merge the results. Opensearch tends to surface
    canonical entity articles ("Mount Everest" for any query mentioning it),
    while full-text search rewards term-frequency matches. Merging gets us
    both behaviors with one pair of cheap API calls."""
    if not query.strip():
        return []
    try:
        async with httpx.AsyncClient(
            timeout=timeout, headers={"User-Agent": _USER_AGENT}
        ) as client:
            opensearch, fulltext = await asyncio.gather(
                _opensearch(client, query, limit),
                _fulltext_search(client, query, limit),
                return_exceptions=True,
            )
    except httpx.HTTPError as exc:
        logger.warning("wikipedia search failed: %s", exc)
        return []

    if isinstance(opensearch, BaseException):
        logger.debug("wikipedia opensearch failed: %s", opensearch)
        opensearch = []
    if isinstance(fulltext, BaseException):
        logger.debug("wikipedia fulltext search failed: %s", fulltext)
        fulltext = []
    return _merge_titles(opensearch, fulltext, limit=limit)


async def fetch_summary(title: str, timeout: float = 5.0) -> dict | None:
    if not title.strip():
        return None
    encoded = urllib.parse.quote(title.replace(" ", "_"))
    url = f"{_SUMMARY_URL}/{encoded}"
    try:
        async with httpx.AsyncClient(
            timeout=timeout, headers={"User-Agent": _USER_AGENT}
        ) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return _parse_summary_response(resp.json(), fallback_title=title)
    except httpx.HTTPError as exc:
        logger.warning("wikipedia summary failed for %s: %s", title, exc)
        return None


# ──────────────── cache helpers ────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _load_cached(db: Session, title: str) -> WikipediaCache | None:
    cached = (
        db.query(WikipediaCache).filter(WikipediaCache.title == title).one_or_none()
    )
    if cached is None:
        return None
    expires = cached.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= _now():
        return None
    return cached


def _store_cache(
    db: Session,
    title: str,
    text: str,
    url: str,
    embedding_vec: list[float],
    ttl_days: int,
) -> None:
    expires = _now() + timedelta(days=ttl_days)
    existing = (
        db.query(WikipediaCache).filter(WikipediaCache.title == title).one_or_none()
    )
    if existing:
        existing.text = text
        existing.url = url
        existing.embedding = embedding_vec
        existing.expires_at = expires
        existing.fetched_at = _now()
    else:
        db.add(
            WikipediaCache(
                title=title,
                text=text,
                url=url,
                embedding=embedding_vec,
                expires_at=expires,
            )
        )
    db.commit()


# ──────────────── main entry point ────────────────


async def wikipedia_evidence(
    db: Session,
    claim: str,
    query_embedding: Iterable[float],
    settings: Settings,
) -> list[dict]:
    """Returns evidence dicts compatible with retrieve_evidence's output:
    {source, source_class, url, title, text, similarity}."""
    titles = await search_titles(
        claim,
        limit=settings.wikipedia_top_k,
        timeout=settings.request_timeout_seconds,
    )
    if not titles:
        return []

    qv = np.asarray(list(query_embedding), dtype=np.float32)
    matches: list[dict] = []
    for title in titles:
        cached = _load_cached(db, title)
        if cached is not None:
            text = cached.text
            embedding_vec: list[float] = list(cached.embedding)
            url = cached.url
        else:
            summary = await fetch_summary(
                title, timeout=settings.request_timeout_seconds
            )
            if summary is None:
                continue
            text = summary["extract"]
            url = summary["url"]
            try:
                embedding_arr = await asyncio.to_thread(embed, [text])
                embedding_vec = embedding_arr[0].tolist()
            except Exception as exc:
                logger.warning("wiki embed failed for %s: %s", title, exc)
                continue
            try:
                await asyncio.to_thread(
                    _store_cache,
                    db,
                    summary["title"],
                    text,
                    url,
                    embedding_vec,
                    settings.wikipedia_cache_ttl_days,
                )
            except Exception as exc:
                logger.warning("wiki cache write failed for %s: %s", title, exc)
                db.rollback()

        sim = float(np.dot(qv, np.asarray(embedding_vec, dtype=np.float32)))
        matches.append(
            {
                "source": "wikipedia",
                "source_class": "reference",
                "url": url,
                "title": title,
                "text": text,
                "similarity": sim,
            }
        )

    matches.sort(key=lambda m: m["similarity"], reverse=True)
    return matches[: settings.wikipedia_top_k]
