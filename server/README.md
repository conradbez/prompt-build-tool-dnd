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

`GET /healthz` is a health check. `GET /` serves the built frontend when a
`dist/` folder sits next to `server/` (see Docker below); otherwise it 404s and
the server is API-only.

## Run locally

```bash
cd server
pip install -r requirements.txt
# key via env (or send apiKey per request from the UI)
ANTHROPIC_API_KEY=sk-... uvicorn main:app --port 8000 --reload
```

The Vite dev server proxies `/api/*` → `http://localhost:8000`, so the frontend
works against a local server with no extra config.

## Deploy on Railway (one service, app + API)

The repo root has a **Dockerfile** that builds the frontend and runs this
server, serving the app at `/` and the API at `/run` on the **same origin** —
so the deployed URL is the whole thing, no separate frontend host and no
`VITE_SERVER_URL` to set.

1. New project → Deploy from repo. Leave the service **Root Directory** at the
   repo root (the default) so Railway uses the Dockerfile.
2. Railway builds the image and runs
   `uvicorn main:app --host 0.0.0.0 --port $PORT`.
3. Optionally set `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
   (and `*_MODEL` overrides) as service variables — otherwise the key entered
   in the UI is used.
4. Open the public URL — the app loads and Run works out of the box.

> If Railway is serving the **static site** instead (`POST /run` → 405,
> `GET /run` returns HTML), the service is using Node static detection rather
> than the Dockerfile. Make sure the service Root Directory is the repo root and
> redeploy; Railway prefers the Dockerfile.

**API-only** (no bundled frontend): set Root Directory to `server`; Railway then
installs `requirements.txt` and runs the `Procfile`. Point a separately-hosted
frontend at it with `VITE_SERVER_URL=…`, the toolbar ⚙ field, or a `?server=…`
link.

No state is stored between requests, so a single instance scales trivially.

## Model overrides (env)

| Provider  | Key env var         | Model env var (default)             |
|-----------|---------------------|-------------------------------------|
| Gemini    | `GEMINI_API_KEY`    | `GEMINI_MODEL` (`gemini-3.6-flash`) |
| OpenAI    | `OPENAI_API_KEY`    | `OPENAI_MODEL` (`gpt-4o-mini`)      |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (`claude-sonnet-4-5`) |
