#!/usr/bin/env python3
"""Train a TensorFlow model to classify whether a sentence is a claim."""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path
from typing import Iterable, Tuple

import numpy as np
import pandas as pd

# Reduce TensorFlow startup stalls on some macOS environments.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "1")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "1")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "1")

import tensorflow as tf


NIKCHAR_TRAIN_URI = (
    "hf://datasets/nikchar/claim_detection_training_set/"
    "data/train-00000-of-00001-b490b97942df210e.parquet"
)

NITHIWAT_SPLITS = {
    "train": "data/train-00000-of-00001-b257f2fa7963abd3.parquet",
    "test": "data/test-00000-of-00001-d48b0506d97e25dc.parquet",
    "valid": "data/valid-00000-of-00001-aaf59ec2907a0802.parquet",
}


def format_seconds(seconds: float) -> str:
    total_seconds = int(round(seconds))
    minutes, secs = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours > 0:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes > 0:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def section(title: str) -> None:
    print()
    print("=" * 72)
    print(f"[{title}]")
    print("=" * 72)


class EpochTimingCallback(tf.keras.callbacks.Callback):
    """Print per-epoch timings and key metrics."""

    def on_train_begin(self, logs=None):  # type: ignore[override]
        self.training_start = time.perf_counter()
        self.epoch_start = None
        print("Training started. Live epoch metrics will print below.")

    def on_epoch_begin(self, epoch, logs=None):  # type: ignore[override]
        self.epoch_start = time.perf_counter()
        print(f"\nEpoch {epoch + 1} started...")

    def on_epoch_end(self, epoch, logs=None):  # type: ignore[override]
        logs = logs or {}
        if self.epoch_start is None:
            epoch_duration = 0.0
        else:
            epoch_duration = time.perf_counter() - self.epoch_start
        total_duration = time.perf_counter() - self.training_start

        accuracy = logs.get("accuracy", 0.0)
        val_accuracy = logs.get("val_accuracy", 0.0)
        loss = logs.get("loss", 0.0)
        val_loss = logs.get("val_loss", 0.0)
        auc = logs.get("auc", 0.0)
        val_auc = logs.get("val_auc", 0.0)

        print(
            "Epoch {epoch}: time={epoch_time} total={total_time} "
            "loss={loss:.4f} val_loss={val_loss:.4f} "
            "acc={acc:.4f} val_acc={val_acc:.4f} "
            "auc={auc:.4f} val_auc={val_auc:.4f}".format(
                epoch=epoch + 1,
                epoch_time=format_seconds(epoch_duration),
                total_time=format_seconds(total_duration),
                loss=loss,
                val_loss=val_loss,
                acc=accuracy,
                val_acc=val_accuracy,
                auc=auc,
                val_auc=val_auc,
            )
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train claim detection model with TensorFlow."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("claim_model/artifacts"),
        help="Directory where model and metadata are written.",
    )
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--max-tokens", type=int, default=20000)
    parser.add_argument("--max-length", type=int, default=60)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--val-ratio", type=float, default=0.1)
    parser.add_argument("--test-ratio", type=float, default=0.1)
    return parser.parse_args()


def load_hf_dataframes() -> list[tuple[str, pd.DataFrame]]:
    frames: list[tuple[str, pd.DataFrame]] = []

    nikchar_df = pd.read_parquet(NIKCHAR_TRAIN_URI)
    frames.append(("nikchar_train", nikchar_df))

    for split_name, split_path in NITHIWAT_SPLITS.items():
        frame = pd.read_parquet(f"hf://datasets/Nithiwat/claim-detection/{split_path}")
        frames.append((f"nithiwat_{split_name}", frame))

    return frames


def choose_text_column(df: pd.DataFrame) -> str:
    candidates = (
        "text",
        "sentence",
        "claim",
        "content",
        "statement",
        "input",
        "utterance",
    )
    for name in candidates:
        if name in df.columns:
            return name

    object_cols = [
        col for col in df.columns if pd.api.types.is_object_dtype(df[col].dtype)
    ]
    if not object_cols:
        raise ValueError("Could not find a text column.")
    return object_cols[0]


def choose_label_column(df: pd.DataFrame, text_column: str) -> str:
    candidates = ("label", "labels", "is_claim", "claim_label", "target", "class")
    for name in candidates:
        if name in df.columns:
            return name

    for col in df.columns:
        if col == text_column:
            continue
        series = df[col].dropna()
        if series.empty:
            continue
        unique_count = series.nunique()
        if unique_count == 2:
            return col

    raise ValueError("Could not infer a binary label column.")


def normalize_labels(series: pd.Series) -> pd.Series:
    def parse_scalar(value: object) -> int:
        if value is None:
            return 0
        if isinstance(value, (bool, np.bool_)):
            return int(value)
        if isinstance(value, (int, np.integer)):
            return int(value > 0)
        if isinstance(value, (float, np.floating)):
            if np.isnan(value):
                return 0
            return int(value > 0)
        text = str(value).strip().lower()
        mapped_true = {"claim", "is_claim", "yes", "true", "1"}
        return int(text in mapped_true)

    # Some datasets use token-level labels per sentence (e.g., list[int]).
    has_sequence_values = series.map(
        lambda x: isinstance(x, (list, tuple, set, np.ndarray))
    ).any()
    if has_sequence_values:
        return series.map(
            lambda x: int(
                any(parse_scalar(item) == 1 for item in x)
                if isinstance(x, (list, tuple, set, np.ndarray))
                else parse_scalar(x)
            )
        ).astype("int32")

    if pd.api.types.is_bool_dtype(series):
        return series.astype("int32")

    if pd.api.types.is_numeric_dtype(series):
        numeric = pd.to_numeric(series, errors="coerce").fillna(0).astype("int32")
        return (numeric > 0).astype("int32")

    mapped_true = {"claim", "is_claim", "yes", "true", "1"}
    lowered = series.astype(str).str.strip().str.lower()
    return lowered.isin(mapped_true).astype("int32")


def normalize_source_frame(source_name: str, frame: pd.DataFrame) -> pd.DataFrame:
    text_column = choose_text_column(frame)
    label_column = choose_label_column(frame, text_column=text_column)

    normalized = frame[[text_column, label_column]].copy()
    normalized.columns = ["text", "label_raw"]
    normalized["source"] = source_name
    normalized = normalized.dropna(subset=["text", "label_raw"])
    normalized["text"] = normalized["text"].astype(str).str.strip()
    normalized = normalized[normalized["text"] != ""]
    normalized["label"] = normalize_labels(normalized["label_raw"])
    return normalized[["text", "label", "source"]]


def stratified_split(
    texts: np.ndarray,
    labels: np.ndarray,
    val_ratio: float,
    test_ratio: float,
    seed: int,
) -> Tuple[Tuple[np.ndarray, np.ndarray], Tuple[np.ndarray, np.ndarray], Tuple[np.ndarray, np.ndarray]]:
    if val_ratio + test_ratio >= 1.0:
        raise ValueError("val_ratio + test_ratio must be < 1.0")

    rng = np.random.default_rng(seed)
    train_idx: list[int] = []
    val_idx: list[int] = []
    test_idx: list[int] = []

    for label_value in np.unique(labels):
        indices = np.where(labels == label_value)[0]
        rng.shuffle(indices)

        n_total = len(indices)
        n_test = max(1, int(n_total * test_ratio))
        n_val = max(1, int(n_total * val_ratio))
        n_train = max(1, n_total - n_val - n_test)

        if n_train + n_val + n_test > n_total:
            n_train = n_total - n_val - n_test

        test_part = indices[:n_test]
        val_part = indices[n_test : n_test + n_val]
        train_part = indices[n_test + n_val :]
        if len(train_part) == 0:
            train_part = indices[-n_train:]

        train_idx.extend(train_part.tolist())
        val_idx.extend(val_part.tolist())
        test_idx.extend(test_part.tolist())

    rng.shuffle(train_idx)
    rng.shuffle(val_idx)
    rng.shuffle(test_idx)

    return (
        (texts[train_idx], labels[train_idx]),
        (texts[val_idx], labels[val_idx]),
        (texts[test_idx], labels[test_idx]),
    )


def make_tf_dataset(
    texts: Iterable[str], labels: Iterable[int], batch_size: int, training: bool
) -> tf.data.Dataset:
    ds = tf.data.Dataset.from_tensor_slices((list(texts), list(labels)))
    if training:
        ds = ds.shuffle(4096, seed=42, reshuffle_each_iteration=True)
    return ds.batch(batch_size).prefetch(tf.data.AUTOTUNE)


def build_model(max_tokens: int, max_length: int, train_texts: np.ndarray) -> tf.keras.Model:
    vectorizer = tf.keras.layers.TextVectorization(
        max_tokens=max_tokens,
        output_mode="int",
        output_sequence_length=max_length,
        standardize="lower",
    )
    vectorizer.adapt(train_texts)

    inputs = tf.keras.Input(shape=(1,), dtype=tf.string, name="sentence")
    x = vectorizer(inputs)
    x = tf.keras.layers.Embedding(input_dim=max_tokens, output_dim=128, mask_zero=True)(x)
    x = tf.keras.layers.Bidirectional(
        tf.keras.layers.LSTM(64, return_sequences=True)
    )(x)
    x = tf.keras.layers.GlobalMaxPooling1D()(x)
    x = tf.keras.layers.Dense(64, activation="relu")(x)
    x = tf.keras.layers.Dropout(0.4)(x)
    outputs = tf.keras.layers.Dense(1, activation="sigmoid", name="is_claim")(x)

    model = tf.keras.Model(inputs=inputs, outputs=outputs)
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
        loss="binary_crossentropy",
        metrics=[
            tf.keras.metrics.BinaryAccuracy(name="accuracy"),
            tf.keras.metrics.Precision(name="precision"),
            tf.keras.metrics.Recall(name="recall"),
            tf.keras.metrics.AUC(name="auc"),
        ],
    )
    return model


def main() -> None:
    run_start = time.perf_counter()
    args = parse_args()
    tf.keras.utils.set_random_seed(args.seed)

    section("1/6 LOAD DATASETS")
    stage_start = time.perf_counter()
    raw_sources = load_hf_dataframes()
    loaded_rows = sum(len(frame) for _, frame in raw_sources)
    print(
        f"Loaded {loaded_rows:,} rows from {len(raw_sources)} dataset splits "
        f"in {format_seconds(time.perf_counter() - stage_start)}."
    )

    section("2/6 PREPARE DATA")
    stage_start = time.perf_counter()
    normalized_frames: list[pd.DataFrame] = []
    source_overview: list[str] = []
    for source_name, frame in raw_sources:
        normalized = normalize_source_frame(source_name, frame)
        source_overview.append(
            f"{source_name}: rows={len(normalized):,} claim={(normalized['label'] == 1).sum():,}"
        )
        normalized_frames.append(normalized)

    df = pd.concat(normalized_frames, ignore_index=True).drop_duplicates(
        subset=["text", "label"]
    )
    if df.empty:
        details = "; ".join(source_overview)
        raise ValueError(
            "No training examples remained after preprocessing. "
            f"Per-source summary: {details}"
        )

    texts = df["text"].to_numpy(dtype=str)
    labels = df["label"].astype("int32").to_numpy()
    print("Source summaries:")
    for item in source_overview:
        print(f"- {item}")
    print(f"After merge + dedupe: {len(df):,} rows")
    print(
        f"Class balance -> non_claim: {(labels == 0).sum():,}, "
        f"claim: {(labels == 1).sum():,}"
    )
    print(f"Done in {format_seconds(time.perf_counter() - stage_start)}.")

    section("3/6 SPLIT + BUILD TF DATASETS")
    stage_start = time.perf_counter()
    (x_train, y_train), (x_val, y_val), (x_test, y_test) = stratified_split(
        texts=texts,
        labels=labels,
        val_ratio=args.val_ratio,
        test_ratio=args.test_ratio,
        seed=args.seed,
    )

    train_ds = make_tf_dataset(x_train, y_train, args.batch_size, training=True)
    val_ds = make_tf_dataset(x_val, y_val, args.batch_size, training=False)
    test_ds = make_tf_dataset(x_test, y_test, args.batch_size, training=False)
    train_steps = math.ceil(len(x_train) / args.batch_size)
    val_steps = math.ceil(len(x_val) / args.batch_size)
    test_steps = math.ceil(len(x_test) / args.batch_size)
    print(f"Train samples: {len(x_train):,} ({train_steps} steps/epoch)")
    print(f"Val samples:   {len(x_val):,} ({val_steps} steps/epoch)")
    print(f"Test samples:  {len(x_test):,} ({test_steps} steps)")
    print(f"Done in {format_seconds(time.perf_counter() - stage_start)}.")

    section("4/6 BUILD MODEL")
    stage_start = time.perf_counter()
    model = build_model(args.max_tokens, args.max_length, x_train)
    print(f"Model params: {model.count_params():,}")
    print(f"Done in {format_seconds(time.perf_counter() - stage_start)}.")

    section("5/6 TRAIN MODEL")
    stage_start = time.perf_counter()
    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_auc", mode="max", patience=2, restore_best_weights=True
        ),
        EpochTimingCallback(),
    ]

    history = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=args.epochs,
        callbacks=callbacks,
        verbose=1,
    )
    print(f"Training stage finished in {format_seconds(time.perf_counter() - stage_start)}.")

    section("6/6 EVALUATE + SAVE")
    stage_start = time.perf_counter()
    metrics = model.evaluate(test_ds, return_dict=True, verbose=1)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    model_path = args.output_dir / "claim_detector.keras"
    model.save(model_path)

    metadata = {
        "model_path": str(model_path),
        "text_column": "text",
        "label_column": "label",
        "threshold": 0.5,
        "train_samples": int(len(x_train)),
        "val_samples": int(len(x_val)),
        "test_samples": int(len(x_test)),
        "class_balance": {
            "non_claim": int((labels == 0).sum()),
            "claim": int((labels == 1).sum()),
        },
        "test_metrics": {k: float(v) for k, v in metrics.items()},
        "epochs_ran": int(len(history.history["loss"])),
    }

    metadata_path = args.output_dir / "metadata.json"
    with metadata_path.open("w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(f"Done in {format_seconds(time.perf_counter() - stage_start)}.")
    print()
    print("-" * 72)
    print("TRAINING COMPLETE")
    print("-" * 72)
    print(f"Total wall time: {format_seconds(time.perf_counter() - run_start)}")
    print(f"Model saved to: {model_path}")
    print(f"Metadata saved to: {metadata_path}")
    print("Test metrics:", metadata["test_metrics"])


if __name__ == "__main__":
    main()
