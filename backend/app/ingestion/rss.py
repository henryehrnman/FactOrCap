from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import feedparser
import httpx

logger = logging.getLogger(__name__)

_USER_AGENT = (
    "FactOrCap-Ingest/0.1 (+https://github.com/) "
    "feedparser/python-httpx"
)


def _empty_result(bozo_exc: Exception | None, etag: str | None = None,
                  modified: str | None = None) -> Any:
    return SimpleNamespace(
        entries=[],
        bozo=1 if bozo_exc else 0,
        bozo_exception=bozo_exc,
        etag=etag,
        modified=modified,
    )


def fetch_feed(
    url: str,
    etag: str | None = None,
    modified: str | None = None,
    timeout: float = 10.0,
) -> Any:
    """Fetch a feed via httpx (so we control UA + timeout) and hand the bytes
    to feedparser. Errors are returned as a synthetic empty result with bozo=1
    so the caller can still write an IngestionLog row."""
    headers = {"User-Agent": _USER_AGENT}
    if etag:
        headers["If-None-Match"] = etag
    if modified:
        headers["If-Modified-Since"] = modified

    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
            response = client.get(url)
    except httpx.HTTPError as exc:
        logger.warning("feed fetch failed for %s: %s", url, exc)
        return _empty_result(exc)

    if response.status_code == 304:
        # Nothing changed since last fetch.
        return _empty_result(None, etag=etag, modified=modified)
    if response.status_code >= 400:
        return _empty_result(
            Exception(f"HTTP {response.status_code}"),
            etag=response.headers.get("etag"),
            modified=response.headers.get("last-modified"),
        )

    parsed = feedparser.parse(response.content)
    # Capture conditional-GET headers from the response so the next pass
    # can short-circuit. feedparser populates these from its own fetch path,
    # which we no longer use.
    parsed["etag"] = response.headers.get("etag")
    parsed["modified"] = response.headers.get("last-modified")
    return parsed


def _parse_published(entry: Any) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        value = entry.get(key)
        if value:
            try:
                return datetime.fromtimestamp(time.mktime(value), tz=timezone.utc)
            except (TypeError, OverflowError, ValueError):
                continue
    return None


def iter_entries(parsed: Any) -> Iterator[dict]:
    for entry in parsed.entries:
        url = entry.get("link")
        if not url:
            continue
        yield {
            "url": url,
            "title": entry.get("title", "") or "",
            "summary": entry.get("summary", "") or "",
            "published_at": _parse_published(entry),
        }


def get_feed_metadata(parsed: Any) -> tuple[str | None, str | None]:
    etag = getattr(parsed, "etag", None)
    if etag is None and isinstance(parsed, dict):
        etag = parsed.get("etag")
    modified = getattr(parsed, "modified", None)
    if modified is None and isinstance(parsed, dict):
        modified = parsed.get("modified")
    return etag, modified
