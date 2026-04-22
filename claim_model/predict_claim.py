#!/usr/bin/env python3
"""Run claim detection inference on a sentence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import tensorflow as tf


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Predict whether a sentence is a claim.")
    parser.add_argument(
        "--model-path",
        type=Path,
        default=Path("claim_model/artifacts/claim_detector.keras"),
        help="Path to trained Keras model.",
    )
    parser.add_argument(
        "--metadata-path",
        type=Path,
        default=Path("claim_model/artifacts/metadata.json"),
        help="Path to metadata JSON with threshold config.",
    )
    parser.add_argument(
        "--text",
        type=str,
        required=True,
        help="Sentence to classify.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    model = tf.keras.models.load_model(args.model_path)
    with args.metadata_path.open("r", encoding="utf-8") as f:
        metadata = json.load(f)

    threshold = float(metadata.get("threshold", 0.5))
    # Keras 3 expects an array/tensor batch, not a raw Python list.
    text_batch = np.array([args.text], dtype=object)
    score = float(np.squeeze(model.predict(text_batch, verbose=0)))
    prediction = int(score >= threshold)
    label = "claim" if prediction == 1 else "not_claim"

    print(f"sentence: {args.text}")
    print(f"claim_probability: {score:.4f}")
    print(f"prediction: {label}")


if __name__ == "__main__":
    main()
