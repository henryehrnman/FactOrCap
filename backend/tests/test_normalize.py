from app.pipeline.normalize import chunk_text, claim_hash, normalize_claim


def test_normalize_collapses_whitespace_and_strips_quotes():
    raw = '  “The   Earth orbits   the Sun.”  '
    assert normalize_claim(raw) == "The Earth orbits the Sun."


def test_normalize_handles_nbsp_and_unicode():
    raw = "café is open"
    assert normalize_claim(raw) == "café is open"


def test_normalize_empty():
    assert normalize_claim("") == ""
    assert normalize_claim(None) == ""  # type: ignore[arg-type]


def test_claim_hash_is_stable_across_whitespace_and_case():
    a = claim_hash("The Earth orbits the Sun.")
    b = claim_hash("  the  earth  ORBITS the sun.  ")
    assert a == b
    assert len(a) == 64


def test_claim_hash_differs_across_distinct_claims():
    assert claim_hash("Sharks are fish.") != claim_hash("Sharks are mammals.")


def test_chunk_text_short_input_returns_one_chunk():
    text = "A short sentence."
    assert chunk_text(text, max_chars=100) == [text]


def test_chunk_text_splits_with_overlap_and_prefers_sentence_boundary():
    sentences = ["This is sentence one. "] * 30
    text = "".join(sentences).strip()
    chunks = chunk_text(text, max_chars=100, overlap=20)
    assert len(chunks) > 1
    assert all(len(c) <= 100 for c in chunks)
    # The first chunk should end at a sentence boundary (period+space) when possible.
    assert chunks[0].rstrip().endswith(".")
