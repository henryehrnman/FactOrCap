from __future__ import annotations

import hashlib
import re
import unicodedata

_WS_RE = re.compile(r"\s+")
_QUOTES = "\"'‘’“”«»"


def normalize_claim(text: str) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace(" ", " ")
    text = _WS_RE.sub(" ", text).strip()
    text = text.strip(_QUOTES + " ")
    return text


def claim_hash(text: str) -> str:
    return hashlib.sha256(normalize_claim(text).lower().encode("utf-8")).hexdigest()


def chunk_text(text: str, max_chars: int, overlap: int = 200) -> list[str]:
    """Sliding-window chunker that prefers sentence boundaries."""
    if not text:
        return []
    text = _WS_RE.sub(" ", text).strip()
    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + max_chars, n)
        if end < n:
            window = text[start:end]
            for sep in (". ", "? ", "! ", "; "):
                idx = window.rfind(sep)
                if idx > max_chars // 2:
                    end = start + idx + len(sep)
                    break
        chunks.append(text[start:end].strip())
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return [c for c in chunks if c]
