from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Verdict = Literal["true", "false", "unverified"]
NLILabel = Literal["entailment", "neutral", "contradiction"]


class VerifyRequest(BaseModel):
    claims: list[str] = Field(min_length=1, max_length=25)


class EvidenceMatch(BaseModel):
    source: str
    source_class: str = "news"
    url: str
    title: str | None = None
    text: str
    similarity: float
    nli_label: NLILabel
    nli_score: float
    entailment: float
    contradiction: float
    neutral: float


class FactCheckMatch(BaseModel):
    publisher: str
    rating: str
    review_url: str
    score: float
    parseable: bool = True
    query_similarity: float | None = None
    claim_text: str = ""
    claimant: str = ""


class ClaimVerdict(BaseModel):
    claim: str
    normalized: str
    verdict: Verdict
    score: float
    confidence: float
    evidence: list[EvidenceMatch] = []
    fact_checks: list[FactCheckMatch] = []
    cached: bool = False


class VerifyResponse(BaseModel):
    results: list[ClaimVerdict]
