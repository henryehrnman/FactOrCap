from app.pipeline.wikipedia import (
    _merge_titles,
    _parse_opensearch_response,
    _parse_search_response,
    _parse_summary_response,
    _wiki_url_for,
)


def test_parse_search_returns_titles_in_order():
    data = {
        "query": {
            "search": [
                {"title": "Shark", "snippet": "..."},
                {"title": "Whale shark", "snippet": "..."},
            ]
        }
    }
    assert _parse_search_response(data) == ["Shark", "Whale shark"]


def test_parse_search_empty_response():
    assert _parse_search_response({}) == []
    assert _parse_search_response({"query": {"search": []}}) == []


def test_parse_search_drops_entries_without_title():
    data = {"query": {"search": [{"title": "Shark"}, {"snippet": "no title"}]}}
    assert _parse_search_response(data) == ["Shark"]


def test_parse_summary_returns_extract():
    data = {
        "title": "Shark",
        "type": "standard",
        "extract": "Sharks are a group of elasmobranch fish characterized by a "
        "cartilaginous skeleton, five to seven gill slits on the sides of the head, "
        "and pectoral fins that are not fused to the head.",
        "content_urls": {
            "desktop": {"page": "https://en.wikipedia.org/wiki/Shark"},
        },
    }
    out = _parse_summary_response(data, fallback_title="Shark")
    assert out is not None
    assert out["title"] == "Shark"
    assert out["url"] == "https://en.wikipedia.org/wiki/Shark"
    assert "elasmobranch fish" in out["extract"]


def test_parse_summary_skips_disambiguation():
    data = {"type": "disambiguation", "extract": "x" * 200, "title": "Bass"}
    assert _parse_summary_response(data, fallback_title="Bass") is None


def test_parse_summary_skips_short_extracts():
    # 80-char minimum guards against stub pages whose lede is just the title.
    data = {"type": "standard", "extract": "Shark."}
    assert _parse_summary_response(data, fallback_title="Shark") is None


def test_parse_summary_falls_back_to_synthesized_url():
    data = {"title": "Whale shark", "type": "standard", "extract": "x" * 200}
    out = _parse_summary_response(data, fallback_title="Whale shark")
    assert out is not None
    assert out["url"] == "https://en.wikipedia.org/wiki/Whale_shark"


def test_parse_summary_uses_fallback_title_when_missing():
    data = {"type": "standard", "extract": "x" * 200}
    out = _parse_summary_response(data, fallback_title="Sharks")
    assert out is not None
    assert out["title"] == "Sharks"


def test_parse_summary_handles_non_dict():
    assert _parse_summary_response([], fallback_title="X") is None
    assert _parse_summary_response(None, fallback_title="X") is None  # type: ignore[arg-type]


def test_parse_opensearch_response_extracts_titles():
    data = ["Mount Everest", ["Mount Everest", "Mount Everest disasters", "Mount Everest North"], ["", "", ""], ["", "", ""]]
    assert _parse_opensearch_response(data) == [
        "Mount Everest",
        "Mount Everest disasters",
        "Mount Everest North",
    ]


def test_parse_opensearch_response_handles_malformed():
    assert _parse_opensearch_response([]) == []
    assert _parse_opensearch_response("nope") == []  # type: ignore[arg-type]
    assert _parse_opensearch_response(["q", "not-a-list"]) == []


def test_merge_titles_round_robin_dedupes_across_sources():
    opensearch = ["Mount Everest", "Everest College"]
    fulltext = ["List of highest mountains on Earth", "Mount Everest", "Mountain"]
    merged = _merge_titles(opensearch, fulltext, limit=4)
    # Round-robin: opensearch[0], fulltext[0], opensearch[1], fulltext[1] dropped (dup), fulltext[2]
    assert merged == [
        "Mount Everest",
        "List of highest mountains on Earth",
        "Everest College",
        "Mountain",
    ]


def test_merge_titles_respects_limit():
    a = ["A1", "A2", "A3"]
    b = ["B1", "B2", "B3"]
    assert _merge_titles(a, b, limit=2) == ["A1", "B1"]


def test_merge_titles_handles_empty_inputs():
    assert _merge_titles([], [], limit=5) == []
    assert _merge_titles(["A"], [], limit=5) == ["A"]
    assert _merge_titles([], ["B"], limit=5) == ["B"]


def test_wiki_url_quotes_and_underscores_titles():
    assert _wiki_url_for("Whale shark") == "https://en.wikipedia.org/wiki/Whale_shark"
    assert _wiki_url_for("Café") == "https://en.wikipedia.org/wiki/Caf%C3%A9"
    assert (
        _wiki_url_for("New York City")
        == "https://en.wikipedia.org/wiki/New_York_City"
    )
