# Claim Detection Model (TensorFlow)

This module trains a binary text classifier that predicts whether a sentence is a claim (`1`) or not a claim (`0`).

It loads and combines:

- `nikchar/claim_detection_training_set`
- `Nithiwat/claim-detection` (`train`, `valid`, `test`)

## 1) Create environment and install deps

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r claim_model/requirements.txt
```

## 2) Train

```bash
python claim_model/train_claim_detector.py
```

Optional flags:

- `--epochs 10`
- `--batch-size 64`
- `--max-tokens 20000`
- `--max-length 60`
- `--output-dir claim_model/artifacts`

## 3) Run inference on a sentence

```bash
python claim_model/predict_claim.py --text "The Earth orbits the Sun every 365 days."
```

Expected output:

- `claim_probability`: model confidence for class `claim`
- `prediction`: `claim` or `not_claim`

## Notes

- The script auto-detects text and label columns to handle slight schema differences across datasets.
- Model artifacts are saved in `claim_model/artifacts/`:
  - `claim_detector.keras`
  - `metadata.json`

## 4) Run local API for the Chrome extension

Start a local inference server:

```bash
python claim_model/serve_claim_detector.py
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

Example request:

```bash
curl -X POST http://127.0.0.1:8765/detect-claims \
  -H "Content-Type: application/json" \
  -d '{"sentences":["The Earth orbits the Sun.","Close the door."]}'
```

Then load the root Chrome extension in developer mode and click **Analyze Current Page** in the popup.
