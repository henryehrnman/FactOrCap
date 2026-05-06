from app.config import Settings
from app.pipeline.aggregate import aggregate_signals
from app.pipeline.factcheck import rating_to_score


def _settings() -> Settings:
    return Settings(
        database_url="sqlite:///:memory:",
        verdict_true_threshold=0.4,
        verdict_false_threshold=-0.4,
        factcheck_weight=0.6,
        nli_weight=0.4,
    )


def test_no_signal_returns_unverified_zero_confidence():
    verdict, score, conf = aggregate_signals([], [], _settings())
    assert verdict == "unverified"
    assert score == 0.0
    assert conf == 0.0


def test_strong_entailment_evidence_yields_true():
    evidence = [
        {"similarity": 0.9, "nli_score": 0.95, "source_class": "factcheck"},
        {"similarity": 0.8, "nli_score": 0.85, "source_class": "factcheck"},
    ]
    verdict, score, _ = aggregate_signals(evidence, [], _settings())
    assert verdict == "true"
    assert score > 0.4


def test_strong_contradiction_evidence_yields_false():
    evidence = [
        {"similarity": 0.9, "nli_score": -0.9, "source_class": "factcheck"},
        {"similarity": 0.8, "nli_score": -0.7, "source_class": "factcheck"},
    ]
    verdict, score, _ = aggregate_signals(evidence, [], _settings())
    assert verdict == "false"
    assert score < -0.4


def test_factcheck_signal_dominates_when_disagreeing_with_weak_nli():
    # NLI weakly leans true (0.3); two fact-checkers strongly say false (-1).
    # combined = 0.6 * -1.0 + 0.4 * 0.3 = -0.48 → false.
    evidence = [{"similarity": 0.9, "nli_score": 0.3, "source_class": "factcheck"}]
    fact_checks = [{"score": -1.0}, {"score": -1.0}]
    verdict, score, _ = aggregate_signals(evidence, fact_checks, _settings())
    assert verdict == "false"
    assert score < -0.4


def test_low_similarity_evidence_is_down_weighted():
    evidence = [
        {"similarity": 0.0, "nli_score": 1.0, "source_class": "factcheck"},
        {"similarity": 1.0, "nli_score": -0.8, "source_class": "factcheck"},
    ]
    verdict, score, _ = aggregate_signals(evidence, [], _settings())
    assert verdict == "false"
    assert score < 0


def test_confidence_grows_with_corroboration():
    weak = aggregate_signals(
        [{"similarity": 0.7, "nli_score": 0.5, "source_class": "factcheck"}],
        [],
        _settings(),
    )
    strong = aggregate_signals(
        [{"similarity": 0.9, "nli_score": 0.95, "source_class": "factcheck"}] * 5,
        [{"score": 1.0}, {"score": 1.0}],
        _settings(),
    )
    assert strong[2] > weak[2]


def test_factcheck_class_outweighs_news_class_at_equal_similarity():
    # Same similarity, opposite NLI verdicts. Fact-checker NLI says false,
    # news NLI says true. Source weights (factcheck=1.0, news=0.3) should
    # tip the weighted average toward false.
    evidence = [
        {"similarity": 0.9, "nli_score": -0.9, "source_class": "factcheck"},
        {"similarity": 0.9, "nli_score": 0.9, "source_class": "news"},
    ]
    verdict, score, _ = aggregate_signals(evidence, [], _settings())
    assert verdict == "false"
    assert score < -0.4


def test_missing_source_class_defaults_to_news_weight():
    # Single piece of evidence: weight cancels in the weighted mean, so
    # the resulting score equals the raw nli_score.
    evidence_default = [{"similarity": 0.9, "nli_score": 0.95}]
    evidence_news = [
        {"similarity": 0.9, "nli_score": 0.95, "source_class": "news"}
    ]
    a = aggregate_signals(evidence_default, [], _settings())
    b = aggregate_signals(evidence_news, [], _settings())
    assert a == b


def test_unknown_source_class_falls_back_to_default():
    evidence = [
        {"similarity": 0.9, "nli_score": 0.95, "source_class": "made_up"}
    ]
    verdict, score, _ = aggregate_signals(evidence, [], _settings())
    assert verdict == "true"
    assert score > 0.4


def test_rating_to_score_known_phrases():
    assert rating_to_score("True") == 1.0
    assert rating_to_score("False") == -1.0
    assert rating_to_score("Mostly False") == -0.7
    assert rating_to_score("Mostly True") == 0.7
    assert rating_to_score("Pants on Fire") == -1.0
    assert rating_to_score("Half True") == 0.0
    # Unknown short labels and empties are now None (unparseable) rather than 0.
    assert rating_to_score("") is None
    assert rating_to_score("something we have never seen before") is None


def test_rating_to_score_collapses_long_paragraph_ratings_to_none():
    paragraph = (
        "This is exaggerated. It's true that Mr Trump's administration has "
        "increased the amount of military funding. However, the levels of "
        "spending is lower than what was spent on the military during Mr "
        "Obama's first administration when adjusted for inflation."
    )
    # The leading sentence is too long for a confident keyword scan, so we
    # bail rather than risking an accidental hit on 'true' inside the body.
    assert rating_to_score(paragraph) is None


def test_rating_to_score_takes_first_sentence_when_possible():
    assert rating_to_score("False. The senator never said this.") == -1.0


def test_aggregate_ignores_unparseable_factchecks():
    # One parseable -1, two unparseable should NOT pull the average toward 0.
    fact_checks = [
        {"score": -1.0, "parseable": True},
        {"score": 0.0, "parseable": False},
        {"score": 0.0, "parseable": False},
    ]
    verdict, score, _ = aggregate_signals([], fact_checks, _settings())
    assert verdict == "false"
    assert score == -1.0


def test_confidence_drops_when_signals_disagree():
    mixed = aggregate_signals(
        [{"similarity": 0.9, "nli_score": 0.9, "source_class": "factcheck"}] * 3
        + [{"similarity": 0.9, "nli_score": -0.9, "source_class": "factcheck"}] * 2,
        [],
        _settings(),
    )
    aligned = aggregate_signals(
        [{"similarity": 0.9, "nli_score": 0.9, "source_class": "factcheck"}] * 5,
        [],
        _settings(),
    )
    # Both have 5 signals; mixed has agreement 3/5, aligned has 5/5.
    assert mixed[2] < aligned[2]


def test_neutral_evidence_does_not_dilute_strong_signal():
    # 1 strong entailment + 5 neutral matches at similar similarity.
    # The neutrals contribute no signal and should drop out (weight 0),
    # leaving the strong signal to drive the verdict.
    evidence = [
        {"similarity": 0.85, "nli_score": 1.0, "source_class": "reference"},
    ] + [
        {"similarity": 0.75, "nli_score": 0.0, "source_class": "reference"}
    ] * 5
    verdict, score, _ = aggregate_signals(evidence, [], _settings())
    assert verdict == "true"
    assert score >= 0.9


def test_confidence_zero_when_no_signal():
    _, _, conf = aggregate_signals([], [], _settings())
    assert conf == 0.0
