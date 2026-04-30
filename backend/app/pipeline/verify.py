from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models.db import ClaimCache
from app.models.schemas import ClaimVerdict, EvidenceMatch, FactCheckMatch
from app.pipeline.aggregate import aggregate_signals
from app.pipeline.embedding import embed
from app.pipeline.factcheck import search_google_factcheck
from app.pipeline.nli import score_pairs
from app.pipeline.normalize import claim_hash, normalize_claim
from app.pipeline.retrieval import retrieve_evidence
from app.pipeline.wikipedia import wikipedia_evidence

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _load_cache(db: Session, claim_hash_value: str) -> ClaimCache | None:
    cached = db.query(ClaimCache).filter(ClaimCache.claim_hash == claim_hash_value).one_or_none()
    if cached is None:
        return None
    expires_at = cached.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= _now():
        return None
    return cached


def _store_cache(
    db: Session,
    claim_hash_value: str,
    claim_text: str,
    normalized: str,
    verdict: str,
    score: float,
    payload: dict,
    ttl_seconds: int,
) -> None:
    expires_at = _now() + timedelta(seconds=ttl_seconds)
    existing = db.query(ClaimCache).filter(ClaimCache.claim_hash == claim_hash_value).one_or_none()
    if existing:
        existing.claim_text = claim_text
        existing.normalized = normalized
        existing.verdict = verdict
        existing.score = score
        existing.payload = payload
        existing.expires_at = expires_at
    else:
        db.add(
            ClaimCache(
                claim_hash=claim_hash_value,
                claim_text=claim_text,
                normalized=normalized,
                verdict=verdict,
                score=score,
                payload=payload,
                expires_at=expires_at,
            )
        )
    db.commit()


async def verify_claim(
    db: Session,
    claim_text: str,
    settings: Settings | None = None,
) -> ClaimVerdict:
    settings = settings or get_settings()
    normalized = normalize_claim(claim_text)

    if len(normalized) < 5:
        return ClaimVerdict(
            claim=claim_text,
            normalized=normalized,
            verdict="unverified",
            score=0.0,
            confidence=0.0,
        )

    h = claim_hash(normalized)
    cached = _load_cache(db, h)
    if cached is not None:
        payload = dict(cached.payload)
        payload["cached"] = True
        return ClaimVerdict.model_validate(payload)

    # Fire Google fact-check + embedding in parallel. NLI/retrieval need the
    # embedding so they're sequenced after.
    fc_task = asyncio.create_task(
        search_google_factcheck(
            normalized,
            api_key=settings.google_factcheck_api_key,
            timeout=settings.request_timeout_seconds,
        )
    )
    embedding_vec = await asyncio.to_thread(lambda: embed([normalized])[0].tolist())

    matches = await asyncio.to_thread(
        retrieve_evidence,
        db,
        embedding_vec,
        settings.retrieval_top_k,
        settings.retrieval_min_similarity,
    )

    # Wikipedia fallback for general factual claims the news/factcheck corpus
    # doesn't cover. Triggered when in-corpus retrieval is empty or weak.
    if settings.wikipedia_fallback_enabled:
        max_sim = max((float(m["similarity"]) for m in matches), default=0.0)
        if not matches or max_sim < settings.wikipedia_fallback_threshold:
            try:
                wiki_matches = await wikipedia_evidence(
                    db, normalized, embedding_vec, settings
                )
                if wiki_matches:
                    logger.debug(
                        "wikipedia fallback added %d matches (corpus max_sim=%.2f)",
                        len(wiki_matches),
                        max_sim,
                    )
                matches = list(matches) + wiki_matches
            except Exception as exc:
                logger.warning("wikipedia fallback failed: %s", exc)

    evidence_with_nli: list[dict] = []
    if matches:
        premises = [m["text"][:1500] for m in matches]
        hypotheses = [normalized] * len(matches)
        nli_results = await asyncio.to_thread(score_pairs, premises, hypotheses)
        for m, n in zip(matches, nli_results):
            evidence_with_nli.append({**m, "nli_score": n["score"], **n})

    try:
        fact_checks = await fc_task
    except Exception as exc:  # network errors already logged inside; this is belt+braces
        logger.warning("fact-check task raised: %s", exc)
        fact_checks = []

    # Google Fact Check Tools is keyword search — it'll happily return reviews
    # of unrelated claims that share words with ours. Drop matches whose
    # claimant text isn't semantically close to our claim. Embeddings are
    # already L2-normalized so dot product = cosine similarity.
    if fact_checks:
        import numpy as np

        fc_texts = [
            (f.get("claim_text") or f.get("rating") or "").strip() for f in fact_checks
        ]
        if any(fc_texts):
            try:
                fc_embeddings = await asyncio.to_thread(embed, fc_texts)
                qv = np.asarray(embedding_vec, dtype=np.float32)
                kept: list[dict] = []
                for f, e in zip(fact_checks, fc_embeddings):
                    sim = float(np.dot(qv, e))
                    f["query_similarity"] = sim
                    if sim >= settings.factcheck_relevance_threshold:
                        kept.append(f)
                logger.debug(
                    "fact-check relevance filter: %d/%d kept (threshold=%.2f)",
                    len(kept),
                    len(fact_checks),
                    settings.factcheck_relevance_threshold,
                )
                fact_checks = kept
            except Exception as exc:
                logger.warning("fact-check relevance filter failed: %s", exc)

    verdict, score, confidence = aggregate_signals(evidence_with_nli, fact_checks, settings)

    evidence_payload = [
        EvidenceMatch(
            source=m["source"],
            source_class=m.get("source_class") or "news",
            url=m["url"],
            title=m.get("title"),
            text=m["text"][:600],
            similarity=float(m["similarity"]),
            nli_label=m["label"],
            nli_score=float(m["nli_score"]),
            entailment=float(m["entailment"]),
            contradiction=float(m["contradiction"]),
            neutral=float(m["neutral"]),
        )
        for m in evidence_with_nli
    ]
    fact_check_payload = [
        FactCheckMatch(
            publisher=fc["publisher"],
            rating=fc["rating"],
            review_url=fc["review_url"],
            score=float(fc["score"]),
            parseable=bool(fc.get("parseable", True)),
            query_similarity=fc.get("query_similarity"),
            claim_text=fc.get("claim_text", ""),
            claimant=fc.get("claimant", ""),
        )
        for fc in fact_checks
    ]

    result = ClaimVerdict(
        claim=claim_text,
        normalized=normalized,
        verdict=verdict,  # type: ignore[arg-type]
        score=score,
        confidence=confidence,
        evidence=evidence_payload,
        fact_checks=fact_check_payload,
        cached=False,
    )

    payload = result.model_dump(mode="json")
    payload["cached"] = False
    try:
        await asyncio.to_thread(
            _store_cache,
            db,
            h,
            claim_text,
            normalized,
            verdict,
            score,
            payload,
            settings.verdict_cache_ttl_seconds,
        )
    except Exception as exc:
        logger.warning("could not write claim cache: %s", exc)
        db.rollback()

    return result


async def verify_claims(
    db: Session,
    claims: list[str],
    settings: Settings | None = None,
) -> list[ClaimVerdict]:
    settings = settings or get_settings()
    # Sequential to keep DB session usage simple. Each claim still fans out
    # internally (Google + embedding in parallel).
    results: list[ClaimVerdict] = []
    for claim in claims:
        results.append(await verify_claim(db, claim, settings))
    return results
