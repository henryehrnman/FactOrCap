from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


_BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "info"

    cors_origins: str = "*"

    database_url: str = (
        "postgresql+psycopg://factorcap:factorcap@localhost:5433/factorcap"
    )

    google_factcheck_api_key: str = ""

    embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_dim: int = 384
    nli_model: str = "MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli"
    claim_extraction_model: str = ""

    retrieval_top_k: int = 10
    retrieval_min_similarity: float = 0.5

    verdict_true_threshold: float = 0.4
    verdict_false_threshold: float = -0.4

    verdict_cache_ttl_seconds: int = 3600

    factcheck_weight: float = 0.6
    nli_weight: float = 0.4

    # Drop Google fact-check matches whose claim_text isn't semantically
    # close to the query. Google Fact Check Tools is a keyword search and
    # routinely returns reviews of unrelated claims that share keywords.
    # 0.8 chosen empirically: real direct hits (e.g. Snopes' actual review of
    # the queried image) cluster above 0.9 cosine similarity, while tangential
    # fact-checks that share a topic cluster around 0.6-0.8. A single
    # tangential FC at -0.5 weighted at 0.6 will outvote a strong NLI
    # consensus, so we want this filter conservative.
    factcheck_relevance_threshold: float = 0.8

    # On-demand Wikipedia retrieval covers general factual claims (biology,
    # geography, public figures, etc.) that the news/factcheck corpus misses.
    # Triggers when the in-corpus retrieval is weak.
    wikipedia_fallback_enabled: bool = True
    # 0.75 chosen empirically: corpus matches in [0.6, 0.75] are typically
    # topically related but claim-irrelevant (e.g. "Mountaineer climbs Everest
    # for Palestinian" hits 0.67 against "Everest is the tallest mountain"),
    # so we still want Wikipedia in that band.
    wikipedia_fallback_threshold: float = 0.75
    wikipedia_top_k: int = 5
    wikipedia_cache_ttl_days: int = 7

    chunk_max_chars: int = 1500
    chunk_overlap_chars: int = 200

    request_timeout_seconds: float = 10.0

    @property
    def cors_origins_list(self) -> list[str]:
        raw = (self.cors_origins or "*").strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
