#!/usr/bin/env python3
"""Serve claim detection predictions over local HTTP for the extension."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import tensorflow as tf


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a local HTTP server for claim detection inference."
    )
    parser.add_argument(
        "--host", type=str, default="127.0.0.1", help="Host to bind to."
    )
    parser.add_argument("--port", type=int, default=8765, help="Port to bind to.")
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
        help="Path to model metadata JSON.",
    )
    return parser.parse_args()


def build_handler(
    model: tf.keras.Model, threshold: float
) -> type[BaseHTTPRequestHandler]:
    class ClaimHandler(BaseHTTPRequestHandler):
        def _set_headers(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_OPTIONS(self) -> None:
            self._set_headers(204)

        def do_GET(self) -> None:
            if self.path != "/health":
                self._set_headers(404)
                self.wfile.write(json.dumps({"error": "not_found"}).encode("utf-8"))
                return

            self._set_headers(200)
            self.wfile.write(
                json.dumps(
                    {"status": "ok", "model_loaded": True, "threshold": threshold}
                ).encode("utf-8")
            )

        def do_POST(self) -> None:
            if self.path != "/detect-claims":
                self._set_headers(404)
                self.wfile.write(json.dumps({"error": "not_found"}).encode("utf-8"))
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                payload = json.loads(raw_body.decode("utf-8"))
            except Exception:
                self._set_headers(400)
                self.wfile.write(
                    json.dumps({"error": "invalid_json_body"}).encode("utf-8")
                )
                return

            sentences = payload.get("sentences", [])
            if not isinstance(sentences, list):
                self._set_headers(400)
                self.wfile.write(
                    json.dumps({"error": "sentences_must_be_a_list"}).encode("utf-8")
                )
                return

            cleaned_sentences = [
                str(sentence).strip()
                for sentence in sentences
                if isinstance(sentence, (str, int, float)) and str(sentence).strip()
            ]
            if not cleaned_sentences:
                self._set_headers(400)
                self.wfile.write(
                    json.dumps({"error": "sentences_must_not_be_empty"}).encode(
                        "utf-8"
                    )
                )
                return

            # Keras 3 expects an array/tensor batch input.
            text_batch = np.array(cleaned_sentences, dtype=object)
            scores = np.squeeze(model.predict(text_batch, verbose=0))
            if np.isscalar(scores):
                scores = np.array([float(scores)])

            results: list[dict[str, Any]] = []
            for sentence, score in zip(cleaned_sentences, scores):
                score_value = float(score)
                results.append(
                    {
                        "sentence": sentence,
                        "claim_probability": score_value,
                        "prediction": "claim"
                        if score_value >= threshold
                        else "not_claim",
                    }
                )

            self._set_headers(200)
            self.wfile.write(
                json.dumps(
                    {
                        "threshold": threshold,
                        "count": len(results),
                        "results": results,
                    }
                ).encode("utf-8")
            )

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return ClaimHandler


def main() -> None:
    args = parse_args()

    model = tf.keras.models.load_model(args.model_path)
    with args.metadata_path.open("r", encoding="utf-8") as handle:
        metadata = json.load(handle)
    threshold = float(metadata.get("threshold", 0.5))

    handler = build_handler(model, threshold)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(
        f"Claim detector server running at http://{args.host}:{args.port} (threshold={threshold})"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
