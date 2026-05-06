# Local development setup

End-to-end steps to run FactOrCap locally — the Chrome extension (Standard mode)
plus the optional backend (Enhanced ALPHA mode). Skip the backend section if
you only care about Standard mode.

## Prerequisites

- **Chrome** (or any Chromium browser with `chrome://extensions`)
- **Python 3.11+** — backend only
- **Docker Desktop** — backend only; runs the pgvector Postgres container
- **Node.js 22+** — only needed if you'll run `npm run lint` locally

You'll also need:

- A **Google Fact Check Tools API key** — free.
  Get one at <https://console.cloud.google.com/apis/credentials>; before generating the key, enable the "Fact Check Tools API" in the same project. No billing required.
- Optional: a **Gemini API key** for the AI fallback — <https://aistudio.google.com/app/apikey>.

---

## 1. Clone

```bash
git clone https://github.com/<owner>/FactOrCap.git
cd FactOrCap
```

---

## 2. Run the extension (Standard mode)

This is enough for the published Google Fact Check + Gemini path.

```bash
cp config.template.js config.js
```

Open `config.js` and paste your keys in place of the `__…__` placeholders:

```js
self.GOOGLE_FACT_CHECK_API_KEY = 'AIzaSy…your key…';
self.GEMINI_API_KEY = ''; // leave blank to disable AI fallback
```

Load the extension in Chrome:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `FactOrCap/` folder (the one with `manifest.json` directly inside).
4. Pin the extension via the puzzle-piece icon in the toolbar.
5. Click the FactOrCap icon on any normal web page to open the sidebar.

You're done if you only want Standard mode. The Enhanced toggle in the sidebar will only work after step 3 below.

---

## 3. Run the backend (Enhanced ALPHA mode)

### 3a. One-time Python setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
```

Open `backend/.env` and fill in:

```
GOOGLE_FACTCHECK_API_KEY=AIzaSy…your key…
```

> **Naming gotcha:** the backend env var is `GOOGLE_FACTCHECK_API_KEY` (no underscore between FACT and CHECK). The extension uses `GOOGLE_FACT_CHECK_API_KEY` (with underscore). They live in different places and are intentionally not unified — don't try to standardize them.

### 3b. Start Postgres

Make sure Docker Desktop is running, then from `backend/`:

```bash
docker compose up -d
docker compose ps          # 'factorcap-postgres' should show "healthy"
```

Postgres listens on `localhost:5433` (intentionally non-default to avoid clashing with anything else you might have on 5432).

If `docker compose up -d` complains about port 5433 being in use, find the culprit with `lsof -i :5433` and either stop it or change the host port in `backend/docker-compose.yml` (and the `DATABASE_URL` in `backend/.env` to match).

### 3c. Populate the evidence corpus

```bash
factorcap-ingest --feeds feeds.yaml
```

First pass takes a few minutes — pulls RSS, extracts article text with trafilatura (or parses ClaimReview JSON-LD on fact-checker sites), embeds chunks into pgvector. Re-run anytime; subsequent passes are cheap because most feeds support conditional GETs.

### 3d. Start the API

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

> **First call is slow.** The first `/verify` request downloads ~2 GB of model weights (`BAAI/bge-small-en-v1.5` for embedding, `MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli` for NLI). Watch uvicorn's logs — you'll see `Loading weights:` progress bars. Subsequent calls are warm and fast.

Health check:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

### 3e. Use Enhanced mode in the extension

1. Click the FactOrCap icon → sidebar opens.
2. In the header, click the **Enhanced (ALPHA)** pill.
3. The toggle persists across pages and sessions.
4. Scan a page; cards now flow through the local backend (yellow `ALPHA` badge on each card).

Switch back to **Standard** anytime — when you toggle, the existing claims re-check under the new mode.

---

## Common gotchas

| Problem                                                                               | Fix                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Could not establish connection. Receiving end does not exist.` in the service worker | Refresh the page you're scanning. Content scripts get re-injected after extension reload, but only on page load.                                 |
| `Enhanced backend unreachable` in the sidebar                                         | Check `uvicorn` is running on 127.0.0.1:8000 and `docker compose ps` shows postgres healthy.                                                     |
| Backend fails on startup with a missing-column error                                  | A schema field changed since your DB was created. Wipe the volume: `docker compose down -v && docker compose up -d`, then re-ingest.             |
| First `/verify` hangs for 5–10 min                                                    | Models are downloading. Tail uvicorn's output.                                                                                                   |
| Extension changes don't appear                                                        | Reload at `chrome://extensions` **and** refresh the page being tested. For changes to `background.js`, the reload alone is enough.               |
| `chrome://` pages don't work                                                          | Content scripts can't run on Chrome internal pages, the Chrome Web Store, or `about:` pages. Try a regular http/https page.                      |
| Verdicts feel stale after a code change                                               | The backend caches verdicts for 1 hour. Wipe it with `docker compose exec postgres psql -U factorcap -d factorcap -c "DELETE FROM claim_cache;"` |

---

## Tests

```bash
cd backend
pytest                      # 45 tests, all offline, ~0.3s
```

The test suite never touches the network or downloads models — safe to run anywhere.

---

## Reset state

```bash
# Just clear cached verdicts (force fresh /verify each call)
docker compose exec postgres psql -U factorcap -d factorcap \
  -c "DELETE FROM claim_cache;"

# Nuke the entire DB and start fresh (destroys all ingested evidence)
docker compose down -v
docker compose up -d
factorcap-ingest --feeds feeds.yaml
```
