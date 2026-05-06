from app.ingestion.claimreview import (
    parse_claim_reviews_html,
    review_chunks,
    to_evidence_text,
)
from app.pipeline.normalize import chunk_text


_PAGE = "https://example.org/factcheck/abc"


def _wrap_jsonld(payload: str) -> str:
    return f'<html><head><script type="application/ld+json">{payload}</script></head><body>x</body></html>'


def test_parses_top_level_claimreview():
    html = _wrap_jsonld(
        """
        {
          "@context": "https://schema.org",
          "@type": "ClaimReview",
          "url": "https://example.org/factcheck/abc",
          "datePublished": "2025-04-01",
          "claimReviewed": "Sharks are mammals.",
          "itemReviewed": {
            "@type": "Claim",
            "author": {"@type": "Person", "name": "Some Person"}
          },
          "author": {"@type": "Organization", "name": "ExampleCheck"},
          "reviewRating": {
            "@type": "Rating",
            "ratingValue": "1",
            "bestRating": "5",
            "alternateName": "False"
          },
          "reviewBody": "Sharks are fish, not mammals. They have gills, not lungs."
        }
        """
    )
    reviews = parse_claim_reviews_html(html, page_url=_PAGE)
    assert len(reviews) == 1
    r = reviews[0]
    assert r["claim"] == "Sharks are mammals."
    assert r["rating"] == "False"
    assert r["publisher"] == "ExampleCheck"
    assert r["claimant"] == "Some Person"
    assert r["review_url"] == _PAGE
    assert "gills, not lungs" in r["review_body"]


def test_parses_claimreview_inside_graph():
    html = _wrap_jsonld(
        """
        {
          "@context": "https://schema.org",
          "@graph": [
            {"@type": "WebPage", "url": "https://example.org/x"},
            {
              "@type": ["ClaimReview"],
              "claimReviewed": "The moon is made of cheese.",
              "reviewRating": {"@type": "Rating", "alternateName": "Pants on Fire"},
              "reviewBody": "It is not."
            }
          ]
        }
        """
    )
    reviews = parse_claim_reviews_html(html, page_url=_PAGE)
    assert len(reviews) == 1
    assert reviews[0]["rating"] == "Pants on Fire"


def test_parses_multiple_claimreviews_on_one_page():
    html = _wrap_jsonld(
        """
        [
          {"@type": "ClaimReview", "claimReviewed": "Claim A.",
           "reviewRating": {"alternateName": "True"}, "reviewBody": "Yes."},
          {"@type": "ClaimReview", "claimReviewed": "Claim B.",
           "reviewRating": {"alternateName": "False"}, "reviewBody": "No."}
        ]
        """
    )
    reviews = parse_claim_reviews_html(html, page_url=_PAGE)
    assert len(reviews) == 2
    assert {r["rating"] for r in reviews} == {"True", "False"}


def test_returns_empty_when_no_jsonld_or_no_claimreview():
    assert parse_claim_reviews_html("<html><body>nothing here</body></html>", _PAGE) == []
    html = _wrap_jsonld('{"@type": "NewsArticle", "headline": "hi"}')
    assert parse_claim_reviews_html(html, _PAGE) == []


def test_skips_invalid_jsonld_block_silently():
    html = (
        '<html><script type="application/ld+json">{ not valid }</script>'
        + _wrap_jsonld(
            '{"@type": "ClaimReview", "claimReviewed": "x",'
            ' "reviewRating": {"alternateName": "False"}, "reviewBody": "no"}'
        )
        + "</html>"
    )
    reviews = parse_claim_reviews_html(html, _PAGE)
    assert len(reviews) == 1
    assert reviews[0]["claim"] == "x"


def test_to_evidence_text_puts_claim_and_verdict_first():
    review = {
        "claim": "Sharks are mammals.",
        "rating": "False",
        "publisher": "ExampleCheck",
        "claimant": "",
        "review_body": "Sharks have gills.",
    }
    text = to_evidence_text(review)
    assert text.startswith("Claim: Sharks are mammals.")
    assert "Verdict: False" in text
    assert "Sharks have gills" in text


def test_review_chunks_repeats_prefix_on_each_chunk():
    review = {
        "claim": "X is true.",
        "rating": "False",
        "review_body": "Sentence one. " * 200,  # ~2800 chars, will split
    }
    chunks = list(review_chunks(review, chunker=chunk_text, max_chars=600, overlap=80))
    assert len(chunks) > 1
    for c in chunks:
        assert c.startswith("Claim: X is true. Verdict: False.")
