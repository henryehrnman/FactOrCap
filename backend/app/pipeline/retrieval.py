from __future__ import annotations

from typing import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.db import Evidence


def retrieve_evidence(
    db: Session,
    query_embedding: Sequence[float],
    top_k: int,
    min_similarity: float,
) -> list[dict]:
    """Cosine top-K over the evidence table, filtered by min similarity.

    Embeddings are stored normalized so cosine_distance = 1 - cosine_similarity.
    pgvector's IVFFlat index is hit by ORDER BY distance + LIMIT.
    """
    if top_k <= 0:
        return []

    distance = Evidence.embedding.cosine_distance(list(query_embedding))
    similarity = (1 - distance).label("similarity")

    stmt = (
        select(
            Evidence.id,
            Evidence.source,
            Evidence.source_class,
            Evidence.url,
            Evidence.title,
            Evidence.text,
            similarity,
        )
        .order_by(distance)
        .limit(top_k)
    )
    rows = db.execute(stmt).mappings().all()
    return [dict(row) for row in rows if float(row["similarity"]) >= min_similarity]
