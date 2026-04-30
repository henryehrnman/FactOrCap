from __future__ import annotations

import threading

from app.config import get_settings


_lock = threading.Lock()
_tokenizer = None
_model = None

# DeBERTa-v3-large-mnli-fever-anli-ling-wanli uses this label order.
LABELS = {0: "entailment", 1: "neutral", 2: "contradiction"}


def get_nli():
    global _tokenizer, _model
    if _model is None:
        with _lock:
            if _model is None:
                import torch  # noqa: F401  (ensures torch is initialized)
                from transformers import AutoModelForSequenceClassification, AutoTokenizer

                name = get_settings().nli_model
                _tokenizer = AutoTokenizer.from_pretrained(name)
                _model = AutoModelForSequenceClassification.from_pretrained(name)
                _model.eval()
    return _tokenizer, _model


def score_pairs(premises: list[str], hypotheses: list[str]) -> list[dict]:
    """For each (premise, hypothesis) pair return entailment/neutral/contradiction
    probabilities and a signed score = P(entail) - P(contradict) ∈ [-1, 1]."""
    if not premises:
        return []
    assert len(premises) == len(hypotheses)

    import torch

    tokenizer, model = get_nli()
    with torch.no_grad():
        batch = tokenizer(
            premises,
            hypotheses,
            return_tensors="pt",
            truncation=True,
            padding=True,
            max_length=512,
        )
        logits = model(**batch).logits
        probs = torch.softmax(logits, dim=-1).cpu().numpy()

    out: list[dict] = []
    for row in probs:
        ent = float(row[0])
        neu = float(row[1])
        con = float(row[2])
        label_idx = int(row.argmax())
        out.append(
            {
                "label": LABELS[label_idx],
                "entailment": ent,
                "neutral": neu,
                "contradiction": con,
                "score": ent - con,
            }
        )
    return out
