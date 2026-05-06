"""schema.org/ClaimReview JSON-LD parser.

Most IFCN-signatory fact-checkers publish structured ClaimReview blocks in
`<script type="application/ld+json">` tags on each fact-check page. Parsing
those gives us a clean (claim, rating, reviewBody) triple — much higher
signal for NLI than running trafilatura over the article body, which mixes
boilerplate, navigation, and the claim itself.

This module:
  - extracts ld+json blocks from raw HTML,
  - walks them (top-level, @graph, or nested) for any node whose @type
    contains "ClaimReview",
  - normalizes the schema variants into a single dict shape,
  - provides a `to_evidence_text` helper that puts (claim, verdict) at the
    front so chunked evidence rows always carry the verdict context.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable, Iterator
from typing import Any

import httpx

logger = logging.getLogger(__name__)


_LD_JSON_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)


def fetch_html(url: str, timeout: float = 10.0) -> str | None:
    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": "FactOrCap-Ingest/0.1 (+https://github.com/)"},
        ) as client:
            resp = client.get(url)
            resp.raise_for_status()
            return resp.text
    except httpx.HTTPError as exc:
        logger.warning("claimreview fetch failed for %s: %s", url, exc)
        return None


def _extract_jsonld_blocks(html: str) -> list[Any]:
    blocks: list[Any] = []
    for match in _LD_JSON_RE.finditer(html):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            blocks.append(json.loads(raw))
        except json.JSONDecodeError:
            # Some sites embed multiple JSON objects concatenated, or have
            # trailing commas. Try a lenient cleanup before giving up.
            cleaned = re.sub(r",\s*([}\]])", r"\1", raw)
            try:
                blocks.append(json.loads(cleaned))
            except json.JSONDecodeError as exc:
                logger.debug("could not parse ld+json block: %s", exc)
    return blocks


def _types_of(node: dict) -> list[str]:
    raw = node.get("@type")
    if isinstance(raw, list):
        return [str(t) for t in raw]
    if raw:
        return [str(raw)]
    return []


def _walk_for_claimreview(node: Any) -> Iterator[dict]:
    if isinstance(node, list):
        for item in node:
            yield from _walk_for_claimreview(item)
    elif isinstance(node, dict):
        if "ClaimReview" in _types_of(node):
            yield node
        for value in node.values():
            if isinstance(value, (list, dict)):
                yield from _walk_for_claimreview(value)


def _get(node: Any, *path: Any, default: Any = None) -> Any:
    cur: Any = node
    for key in path:
        if cur is None:
            return default
        if isinstance(key, int):
            if not isinstance(cur, list) or key >= len(cur):
                return default
            cur = cur[key]
        else:
            if not isinstance(cur, dict):
                return default
            cur = cur.get(key)
    return cur if cur is not None else default


def _name_or_str(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("name", "")).strip()
    if isinstance(value, list) and value:
        return _name_or_str(value[0])
    if value is None:
        return ""
    return str(value).strip()


def _normalize_claimreview(item: dict, fallback_url: str) -> dict | None:
    claim_text = item.get("claimReviewed") or _get(item, "itemReviewed", "name")
    if not claim_text:
        return None

    rating = (
        _get(item, "reviewRating", "alternateName")
        or _get(item, "reviewRating", "name")
        or ""
    )

    review_body = item.get("reviewBody") or item.get("description") or ""
    review_url = item.get("url") or fallback_url
    publisher = _name_or_str(item.get("author")) or _name_or_str(item.get("publisher"))
    claimant = (
        _name_or_str(_get(item, "itemReviewed", "author"))
        or _name_or_str(_get(item, "itemReviewed", "appearance", 0, "author"))
    )

    return {
        "claim": str(claim_text).strip(),
        "rating": str(rating).strip(),
        "rating_value": _get(item, "reviewRating", "ratingValue"),
        "best_rating": _get(item, "reviewRating", "bestRating"),
        "review_body": str(review_body).strip(),
        "review_url": str(review_url).strip(),
        "publisher": publisher,
        "claimant": claimant,
        "date_published": item.get("datePublished") or item.get("dateCreated"),
    }


def parse_claim_reviews_html(html: str, page_url: str) -> list[dict]:
    """Return zero or more normalized ClaimReview dicts from a page's HTML."""
    blocks = _extract_jsonld_blocks(html)
    seen: set[tuple[str, str]] = set()
    reviews: list[dict] = []
    for block in blocks:
        for raw in _walk_for_claimreview(block):
            normalized = _normalize_claimreview(raw, fallback_url=page_url)
            if not normalized:
                continue
            key = (normalized["claim"][:200], normalized["review_url"])
            if key in seen:
                continue
            seen.add(key)
            reviews.append(normalized)
    return reviews


def fetch_claim_reviews(url: str, timeout: float = 10.0) -> list[dict]:
    html = fetch_html(url, timeout=timeout)
    if not html:
        return []
    return parse_claim_reviews_html(html, page_url=url)


def to_evidence_text(review: dict) -> str:
    """Build the evidence string. Claim + verdict come first so chunkers
    that split a long reviewBody still keep the verdict attached to the
    leading chunk; for long bodies, the worker repeats the prefix on each
    chunk (see worker._claimreview_chunks)."""
    parts: list[str] = []
    parts.append(f"Claim: {review['claim']}")
    if review.get("rating"):
        parts.append(f"Verdict: {review['rating']}")
    if review.get("publisher"):
        parts.append(f"Reviewed by: {review['publisher']}")
    if review.get("claimant"):
        parts.append(f"Claimant: {review['claimant']}")
    if review.get("review_body"):
        parts.append(review["review_body"])
    return ". ".join(p.strip().rstrip(".") for p in parts if p.strip()) + "."


def review_chunks(
    review: dict,
    chunker: Any,
    max_chars: int,
    overlap: int,
) -> Iterable[str]:
    """Chunk a ClaimReview's evidence text, repeating the (claim, verdict)
    prefix on every chunk so retrieval hits always surface the verdict."""
    prefix_parts: list[str] = [f"Claim: {review['claim']}"]
    if review.get("rating"):
        prefix_parts.append(f"Verdict: {review['rating']}")
    prefix = ". ".join(p.strip().rstrip(".") for p in prefix_parts) + "."

    body = review.get("review_body") or ""
    if not body:
        return [prefix]

    body_budget = max(max_chars - len(prefix) - 1, 200)
    body_chunks = chunker(body, max_chars=body_budget, overlap=overlap)
    if not body_chunks:
        return [prefix]
    return [f"{prefix} {chunk}" for chunk in body_chunks]
