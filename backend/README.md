# FactOrCap Backend

FastAPI service that takes a list of claims and returns true / false / unverified
verdicts. Combines two signals:

1. **Retrieval + NLI** over an evidence corpus stored in pgvector. The corpus is
   built by the ingestion worker, which pulls news and fact-checking RSS feeds,
   extracts article text with trafilatura, chunks it, embeds it with
   `BAAI/bge-small-en-v1.5`, and writes rows into Postgres. At query time the
   claim is embedded, the top-K most similar evidence chunks are pulled by
   cosine distance, and a DeBERTa NLI model scores each (claim, evidence) pair.
2. **Google Fact Check Tools API** lookup. Verdict ratings ("True", "Mostly False",
   "Pants on Fire", …) are mapped to a numeric score.

A weighted combination produces a final score in `[-1, 1]` and a verdict.

## Layout

```
backend/
├── docker-compose.yml      # pgvector/pgvector:pg16 on :5433
├── init.sql                # CREATE EXTENSION vector
├── feeds.yaml              # ingestion sources
├── pyproject.toml
└── app/
    ├── main.py             # FastAPI app + CORS + lifespan
    ├── config.py           # pydantic-settings, reads .env
    ├── api/verify.py       # POST /verify
    ├── db/session.py       # engine + SessionLocal
    ├── models/
    │   ├── db.py           # SQLAlchemy: Evidence, ClaimCache, IngestionLog
    │   └── schemas.py      # Pydantic request/response
    ├── pipeline/
    │   ├── normalize.py    # claim cleanup + hash
    │   ├── embedding.py    # lazy sentence-transformers
    │   ├── retrieval.py    # pgvector cosine top-K
    │   ├── nli.py          # lazy DeBERTa NLI
    │   ├── factcheck.py    # Google Fact Check API client
    │   ├── aggregate.py    # NLI + factcheck → verdict
    │   └── verify.py       # orchestrator + cache
    └── ingestion/
        ├── rss.py          # feedparser
        ├── extract.py      # trafilatura
        └── worker.py       # `factorcap-ingest` entry point
```

## Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env       # edit values
docker compose up -d       # starts pgvector on localhost:5433
```

The first call to `/verify` will download the embedding + NLI model weights
(~2 GB total). Subsequent calls are warm.

## Run the API

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

`GET /health` for a liveness check. `POST /verify` with:

```json
{ "claims": ["The Earth orbits the Sun.", "Sharks are mammals."] }
```

## Run the ingestion worker

```bash
factorcap-ingest --feeds feeds.yaml          # one pass
factorcap-ingest --feeds feeds.yaml --loop   # continuous, every 10 min
```

## Tests

```bash
pytest
```
