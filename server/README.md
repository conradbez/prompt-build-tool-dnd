# Mind-map runner (FastAPI + pbt)

A tiny, **stateless** server with one meaningful endpoint. It receives the
bullet graph as JSON and returns each bullet's result after flowing through
[prompt-build-tool](https://github.com/conradbez/prompt-build-tool).

## Endpoint

`POST /run`

```jsonc
// request
{
  "provider": "anthropic",          // gemini | openai | anthropic
  "apiKey": "sk-...",               // optional; falls back to server env var
  "nodes": [
    { "id": "a", "title": "Topic", "body": "Pick a topic", "refs": [] },
    { "id": "b", "title": "Tweet", "body": "Write a tweet about it", "refs": ["a"] }
  ]
}
```

```jsonc
// response — outputs keyed by the bullet id you sent
{ "outputs": { "a": "…", "b": "…" }, "errors": [] }
```

Each bullet becomes a pbt model; a bullet's `@` references (`refs`) become
`{{ ref('…') }}` dependencies, so upstream outputs flow into the bullets that
reference them. pbt resolves ordering and runs independent branches in parallel.

`GET /` is a health check.

## Run locally

```bash
cd server
pip install -r requirements.txt
# key via env (or send apiKey per request from the UI)
ANTHROPIC_API_KEY=sk-... uvicorn main:app --port 8000 --reload
```

The Vite dev server proxies `/api/*` → `http://localhost:8000`, so the frontend
works against a local server with no extra config.

## Deploy on Railway

1. New project → Deploy from repo.
2. Set the service **Root Directory** to `server`.
3. Railway installs `requirements.txt` and starts the `Procfile`
   (`uvicorn main:app --host 0.0.0.0 --port $PORT`).
4. Optionally set `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
   (and `*_MODEL` overrides) as service variables — otherwise the key entered
   in the UI is used.
5. Point the frontend at the public URL by building it with
   `VITE_SERVER_URL=https://your-app.up.railway.app`.

No state is stored between requests, so a single instance scales trivially.

## Model overrides (env)

| Provider  | Key env var         | Model env var (default)             |
|-----------|---------------------|-------------------------------------|
| Gemini    | `GEMINI_API_KEY`    | `GEMINI_MODEL` (`gemini-2.0-flash`) |
| OpenAI    | `OPENAI_API_KEY`    | `OPENAI_MODEL` (`gpt-4o-mini`)      |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (`claude-sonnet-4-5`) |
