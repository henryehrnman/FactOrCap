from __future__ import annotations

import threading
from functools import lru_cache

import numpy as np

from app.config import get_settings


_lock = threading.Lock()
_model = None


def get_embedder():
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                # Imported lazily — sentence_transformers pulls in torch and is slow to import.
                from sentence_transformers import SentenceTransformer

                _model = SentenceTransformer(get_settings().embedding_model)
    return _model


def embed(texts: list[str]) -> np.ndarray:
    if not texts:
        return np.zeros((0, get_settings().embedding_dim), dtype=np.float32)
    vectors = get_embedder().encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return vectors.astype(np.float32)


@lru_cache(maxsize=2048)
def embed_cached(text: str) -> tuple[float, ...]:
    return tuple(embed([text])[0].tolist())
