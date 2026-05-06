from __future__ import annotations

import logging
import re

import httpx

logger = logging.getLogger(__name__)

GOOGLE_FACTCHECK_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search"


# Order matters — check more specific phrases first ("mostly false" before "false").
_RATING_TABLE: list[tuple[tuple[str, ...], float]] = [
    (("pants on fire", "pants-on-fire"), -1.0),
    (("fabricated", "hoax", "fake news"), -1.0),
    (("mostly false", "mostly-false", "mostly wrong", "largely false"), -0.7),
    (("misleading", "miscaptioned", "misattributed"), -0.5),
    (("partly false", "partly-false", "half false", "half-false"), -0.3),
    (("mixture", "mixed", "half true", "half-true", "partially true"), 0.0),
    (("unproven", "unverified", "no evidence", "outdated", "lacks context"), 0.0),
    (("mostly true", "mostly-true", "largely true"), 0.7),
    (("verified", "confirmed"), 1.0),
    (("true", "correct", "accurate", "fact"), 1.0),
    (("false", "incorrect", "wrong", "inaccurate", "debunked", "not true"), -1.0),
]

# A "rating" longer than this is almost certainly a paragraph of explanation
# rather than a verdict label. We try to extract the leading sentence; if even
# that is too long to trust, we give up rather than letting accidental keyword
# matches like "true" inside a long explanation flip the score.
_MAX_RATING_LEN_FOR_KEYWORD_SCAN = 80


def rating_to_score(rating: str) -> float | None:
    """Map a textualRating to a score in [-1, 1], or None if we cannot
    confidently parse it. Long paragraph-style ratings collapse to None
    rather than gambling on incidental keyword hits."""
    if not rating:
        return None
    r = rating.lower().strip()

    if len(r) > _MAX_RATING_LEN_FOR_KEYWORD_SCAN:
        first = re.split(r"[.!?]\s+", r, maxsplit=1)[0].strip()
        if 0 < len(first) <= _MAX_RATING_LEN_FOR_KEYWORD_SCAN:
            r = first
        else:
            return None

    for phrases, score in _RATING_TABLE:
        for phrase in phrases:
            if phrase in r:
                return score
    return None


async def search_google_factcheck(
    claim: str,
    api_key: str,
    timeout: float = 10.0,
    language: str = "en",
    page_size: int = 5,
) -> list[dict]:
    """Returns a list of dicts with keys:
        publisher, rating, review_url, score, parseable,
        claim_text, claimant.

    `parseable=False` means rating_to_score couldn't classify the textualRating;
    aggregator should ignore those entries when averaging fact-check scores
    but they're still surfaced in the response for UI context."""
    if not api_key or not claim:
        return []

    params = {
        "key": api_key,
        "query": claim,
        "languageCode": language,
        "pageSize": page_size,
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(GOOGLE_FACTCHECK_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as exc:
        logger.warning("google factcheck request failed: %s", exc)
        return []

    matches: list[dict] = []
    for item in data.get("claims", []):
        for review in item.get("claimReview", []):
            rating = review.get("textualRating", "") or ""
            parsed = rating_to_score(rating)
            matches.append(
                {
                    "publisher": (review.get("publisher") or {}).get("name", ""),
                    "rating": rating,
                    "review_url": review.get("url", ""),
                    "score": parsed if parsed is not None else 0.0,
                    "parseable": parsed is not None,
                    "claim_text": item.get("text", "") or "",
                    "claimant": item.get("claimant", "") or "",
                }
            )
    return matches
