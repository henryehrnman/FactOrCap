from __future__ import annotations

from app.config import Settings


# Per-class trust multipliers applied on top of retrieval similarity. Tuned so
# fact-checker entailments carry roughly 3x the weight of news entailments —
# news articles often quote claims without evaluating them, which inflates
# accidental entailment.
SOURCE_CLASS_WEIGHTS: dict[str, float] = {
    "factcheck": 1.0,
    "reference": 0.8,
    "news": 0.3,
}
DEFAULT_SOURCE_WEIGHT: float = 0.3

# Minimum |score| for a signal to count as "directional" when measuring
# agreement. Anything weaker is bucketed as neutral.
_DIRECTIONAL_THRESHOLD: float = 0.2


def _source_weight(source_class: str | None) -> float:
    if not source_class:
        return DEFAULT_SOURCE_WEIGHT
    return SOURCE_CLASS_WEIGHTS.get(source_class, DEFAULT_SOURCE_WEIGHT)


def _sign(score: float) -> int:
    if score > _DIRECTIONAL_THRESHOLD:
        return 1
    if score < -_DIRECTIONAL_THRESHOLD:
        return -1
    return 0


def _agreement_confidence(combined: float, signs: list[int]) -> float:
    """Magnitude × agreement, with a small sample-size bonus.

    If signals disagree (some say true, some say false), `agreement` drops
    and confidence falls even when |combined| is moderate. This avoids the
    pathological "0.89 confidence on UNVERIFIED" we saw with the old formula.
    """
    if not signs:
        return 0.0
    pos = sum(1 for s in signs if s > 0)
    neg = sum(1 for s in signs if s < 0)
    neu = len(signs) - pos - neg
    agreement = max(pos, neg, neu) / len(signs)
    sample_bonus = min(0.2, 0.03 * len(signs))
    return min(1.0, abs(combined) * agreement + sample_bonus)


def aggregate_signals(
    evidence_with_nli: list[dict],
    fact_checks: list[dict],
    settings: Settings,
) -> tuple[str, float, float]:
    """Combine NLI evidence + Google fact-check matches into (verdict, score, confidence).

    Each NLI evidence row is weighted by `similarity * source_class_weight`,
    so a fact-check article match counts ~3x a news article match at equal
    similarity. Fact-check matches whose textualRating couldn't be parsed
    (`parseable=False`) are surfaced in the response but excluded from the
    score average.
    """
    # Each NLI evidence row's weight = similarity × source_class × |nli_score|.
    # Multiplying by |nli_score| means neutral evidence (NLI doesn't take a
    # position on the claim) drops out of the weighted average rather than
    # dragging the score toward 0. Topically-similar-but-neutral retrieval
    # is the dominant noise mode for general factual claims (e.g. Wikipedia
    # search returns 5 Mount Everest articles where only 1 directly states
    # the height). Without the |score| factor those 4 neutrals would dilute
    # the 1 strong signal.
    nli_score, nli_weight = 0.0, 0.0
    nli_signs: list[int] = []
    for item in evidence_with_nli:
        sim = max(0.0, float(item.get("similarity", 0.0)))
        src_w = _source_weight(item.get("source_class"))
        score = float(item["nli_score"])
        weight = sim * src_w * abs(score)
        if weight <= 0:
            continue
        nli_score += weight * score
        nli_weight += weight
        nli_signs.append(_sign(score))
    nli_avg = nli_score / nli_weight if nli_weight > 0 else 0.0

    parseable_fcs = [fc for fc in fact_checks if fc.get("parseable", True)]
    fc_avg = 0.0
    fc_signs: list[int] = []
    if parseable_fcs:
        fc_avg = sum(float(f["score"]) for f in parseable_fcs) / len(parseable_fcs)
        fc_signs = [_sign(float(f["score"])) for f in parseable_fcs]

    have_nli = nli_weight > 0
    have_fc = bool(parseable_fcs)

    if have_nli and have_fc:
        combined = settings.factcheck_weight * fc_avg + settings.nli_weight * nli_avg
    elif have_fc:
        combined = fc_avg
    elif have_nli:
        combined = nli_avg
    else:
        combined = 0.0

    combined = max(-1.0, min(1.0, combined))

    if combined >= settings.verdict_true_threshold:
        verdict = "true"
    elif combined <= settings.verdict_false_threshold:
        verdict = "false"
    else:
        verdict = "unverified"

    confidence = _agreement_confidence(combined, nli_signs + fc_signs)
    if not (have_nli or have_fc):
        confidence = 0.0

    return verdict, combined, confidence
