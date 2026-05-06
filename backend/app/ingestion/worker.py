from __future__ import annotations

import argparse
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.db.session import Base, SessionLocal, engine
from app.ingestion.claimreview import fetch_claim_reviews, review_chunks
from app.ingestion.extract import extract_article
from app.ingestion.rss import fetch_feed, get_feed_metadata, iter_entries
from app.models.db import Evidence, IngestionLog
from app.pipeline.embedding import embed
from app.pipeline.normalize import chunk_text

logger = logging.getLogger(__name__)


def _last_log_for(db, feed_url: str) -> IngestionLog | None:
    stmt = (
        select(IngestionLog)
        .where(IngestionLog.feed_url == feed_url)
        .order_by(IngestionLog.fetched_at.desc())
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none()


def _evidence_exists(db, url: str, chunk_index: int) -> bool:
    stmt = select(Evidence.id).where(
        Evidence.url == url, Evidence.chunk_index == chunk_index
    )
    return db.execute(stmt).first() is not None


def _store_chunks(
    db,
    *,
    source: str,
    source_class: str,
    base_url: str,
    title: str | None,
    chunks: list[str],
    published_at: datetime,
) -> int:
    """Embed `chunks` and insert one Evidence row per chunk. Returns count
    actually written (skips duplicates that race in)."""
    if not chunks:
        return 0
    try:
        vectors = embed(chunks)
    except Exception as exc:
        logger.warning("embed failed for %s: %s", base_url, exc)
        return 0

    written = 0
    for idx, (chunk, vector) in enumerate(zip(chunks, vectors)):
        if _evidence_exists(db, base_url, idx):
            continue
        db.add(
            Evidence(
                source=source,
                source_class=source_class,
                url=base_url,
                title=title,
                text=chunk,
                chunk_index=idx,
                published_at=published_at,
                embedding=vector.tolist(),
            )
        )
        written += 1
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        logger.debug("duplicate chunks rolled back for %s: %s", base_url, exc)
        return 0
    return written


def _ingest_via_claimreview(
    db,
    *,
    source: str,
    source_class: str,
    entry: dict,
    settings,
) -> int:
    """Returns total Evidence rows inserted. Returns -1 if no ClaimReview
    blocks were found (caller may fall back to article extraction)."""
    page_url = entry["url"]
    reviews = fetch_claim_reviews(page_url, timeout=settings.request_timeout_seconds)
    if not reviews:
        return -1

    published_at = entry.get("published_at") or datetime.now(timezone.utc)
    total = 0
    for cr_idx, review in enumerate(reviews):
        # Each ClaimReview gets its own logical URL. If the review's own url
        # field matches the page or is missing, append a fragment to keep
        # (url, chunk_index) unique across multiple reviews on one page.
        review_url = review.get("review_url") or page_url
        if cr_idx > 0 and review_url == page_url:
            review_url = f"{page_url}#cr-{cr_idx}"

        chunks = list(
            review_chunks(
                review,
                chunker=chunk_text,
                max_chars=settings.chunk_max_chars,
                overlap=settings.chunk_overlap_chars,
            )
        )
        if not chunks:
            continue
        title = (
            f"Fact-check: {review['claim'][:180]}"
            if review.get("claim")
            else entry.get("title")
        )
        total += _store_chunks(
            db,
            source=source,
            source_class=source_class,
            base_url=review_url,
            title=title,
            chunks=chunks,
            published_at=published_at,
        )
    return total


def _ingest_via_article(
    db,
    *,
    source: str,
    source_class: str,
    entry: dict,
    settings,
) -> int:
    url = entry["url"]
    if _evidence_exists(db, url, 0):
        return 0
    text = extract_article(url, summary_fallback=entry.get("summary", ""))
    if not text:
        return 0
    chunks = chunk_text(text, settings.chunk_max_chars, settings.chunk_overlap_chars)
    if not chunks:
        return 0
    published_at = entry.get("published_at") or datetime.now(timezone.utc)
    return _store_chunks(
        db,
        source=source,
        source_class=source_class,
        base_url=url,
        title=entry.get("title") or None,
        chunks=chunks,
        published_at=published_at,
    )


def ingest_feed(
    db,
    *,
    source: str,
    source_class: str,
    feed_url: str,
    use_claimreview: bool,
    settings,
) -> tuple[int, str, str | None]:
    last_log = _last_log_for(db, feed_url)
    parsed = fetch_feed(
        feed_url,
        etag=last_log.etag if last_log else None,
        modified=last_log.last_modified if last_log else None,
        timeout=settings.request_timeout_seconds,
    )

    etag, modified = get_feed_metadata(parsed)
    new_count = 0
    error: str | None = None

    if getattr(parsed, "bozo", 0) and not parsed.entries:
        # Feed didn't parse and gave us no entries — record it instead of
        # silently dropping the feed from the log.
        error = str(getattr(parsed, "bozo_exception", "feed parse error"))
        log = IngestionLog(
            feed_url=feed_url,
            new_items=0,
            status="error",
            error=error,
            etag=etag,
            last_modified=modified,
        )
        db.add(log)
        db.commit()
        return 0, "error", error

    for entry in iter_entries(parsed):
        try:
            if use_claimreview:
                added = _ingest_via_claimreview(
                    db,
                    source=source,
                    source_class=source_class,
                    entry=entry,
                    settings=settings,
                )
                if added < 0:
                    # No ClaimReview JSON-LD on the page; fall back so we
                    # still capture *something* useful.
                    added = _ingest_via_article(
                        db,
                        source=source,
                        source_class=source_class,
                        entry=entry,
                        settings=settings,
                    )
            else:
                added = _ingest_via_article(
                    db,
                    source=source,
                    source_class=source_class,
                    entry=entry,
                    settings=settings,
                )
            new_count += max(0, added)
        except Exception as exc:
            logger.warning("entry failed %s: %s", entry.get("url"), exc)
            error = f"{entry.get('url')}: {exc}"
            db.rollback()

    log = IngestionLog(
        feed_url=feed_url,
        new_items=new_count,
        status="ok" if error is None else "partial",
        error=error,
        etag=etag,
        last_modified=modified,
    )
    db.add(log)
    db.commit()
    return new_count, log.status, error


def run_once(feeds_path: Path) -> int:
    settings = get_settings()
    Base.metadata.create_all(bind=engine)
    spec = yaml.safe_load(feeds_path.read_text())
    feeds = spec.get("feeds", [])

    db = SessionLocal()
    total_new = 0
    try:
        for feed in feeds:
            source = feed.get("source") or feed["url"]
            source_class = feed.get("source_class", "news")
            url = feed["url"]
            use_claimreview = bool(feed.get("claimreview", False))
            try:
                new_count, status, error = ingest_feed(
                    db,
                    source=source,
                    source_class=source_class,
                    feed_url=url,
                    use_claimreview=use_claimreview,
                    settings=settings,
                )
                logger.info(
                    "ingested %s [%s%s]: +%d (%s) %s",
                    source,
                    source_class,
                    ", claimreview" if use_claimreview else "",
                    new_count,
                    status,
                    error or "",
                )
                total_new += new_count
            except Exception as exc:
                logger.exception("ingest failed for %s", url)
                db.rollback()
                db.add(
                    IngestionLog(
                        feed_url=url, new_items=0, status="error", error=str(exc)
                    )
                )
                db.commit()
    finally:
        db.close()
    return total_new


def main() -> None:
    parser = argparse.ArgumentParser(description="FactOrCap ingestion worker")
    parser.add_argument(
        "--feeds",
        type=Path,
        default=Path(__file__).resolve().parent.parent.parent / "feeds.yaml",
        help="Path to feeds.yaml",
    )
    parser.add_argument("--loop", action="store_true", help="Run continuously.")
    parser.add_argument(
        "--interval",
        type=int,
        default=600,
        help="Seconds between passes when --loop is set.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    while True:
        added = run_once(args.feeds)
        logger.info("pass complete, +%d evidence rows", added)
        if not args.loop:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
