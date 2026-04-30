from __future__ import annotations

import logging

import trafilatura

logger = logging.getLogger(__name__)


def extract_article(url: str, summary_fallback: str = "") -> str | None:
    """Pull the main body text from `url`. Falls back to the RSS summary if
    trafilatura can't find anything substantive."""
    try:
        downloaded = trafilatura.fetch_url(url)
    except Exception as exc:
        logger.warning("fetch_url failed for %s: %s", url, exc)
        downloaded = None

    if downloaded:
        try:
            text = trafilatura.extract(
                downloaded,
                include_comments=False,
                include_tables=False,
                favor_recall=False,
            )
        except Exception as exc:
            logger.warning("trafilatura.extract failed for %s: %s", url, exc)
            text = None
        if text and len(text.strip()) >= 200:
            return text.strip()

    if summary_fallback and len(summary_fallback.strip()) >= 200:
        return summary_fallback.strip()
    return None
