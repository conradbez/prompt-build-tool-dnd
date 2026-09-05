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
  "promptdata": { "tone": "formal" },  // optional; run variables, see below
  "nodes": [
    { "id": "a", "text": "# Topic\nPick a topic", "refs": [] },
    { "id": "b", "text": "# Tweet\nWrite a tweet about it", "refs": ["a"] }
  ]
}
```

```jsonc
// response — outputs keyed by the bullet id you sent
{ "outputs": { "a": "…", "b": "…" }, "errors": [] }
```

Each bullet becomes a pbt model. A node **auto-includes its children's outputs**
(children feed up into the parent) plus any explicit `@` references (`refs`) —
both become `{{ ref('…') }}` dependencies. pbt resolves ordering and runs
independent branches in parallel.

The prompt is assembled in this order:

```
<the bullet's own text>
<child 1's output>
<child 2's output>
<each @ reference's output>
```

The bullet's own text comes **first** and the material it is about follows, so
"summarise what follows" means what it says.

An **empty bullet is not skipped** when anything beneath it has text: a blank
bullet is how you write "hand my children's outputs upward", and a child
reaches the root only through its parent, so dropping it would cut off the
whole branch. Only a subtree that is empty all the way down is skipped.

## Run variables (`promptdata`)

`promptdata` is a flat name → value map for the whole run — the settings table
in the UI is one row per entry. A bullet uses one by writing `@name`, and the
server rewrites each `@name` it recognises into `{{ promptdata("name") }}`
before pbt renders it, so the value arrives through pbt's own mechanism rather
than by string-splicing on the way in.

Only **known** names are rewritten. An `@word` matching no variable is left
exactly as typed — it is prose, not a broken reference — and a name that is not
`[A-Za-z0-9_]+` is dropped from the map rather than written into a template.
The `@` must also start a word, so an email address in a prompt is safe.

Variables work in the **global instruction** too, and are the only variable that
can: pbt refuses `ref()` there (it would make every model depend on one) and
points at `promptdata` instead.

The `prompts` in the response show variables **filled in**, not as the Jinja
call they compiled to — that column answers "what did the model actually see".

One ambiguity is left standing, since both features share the `@`: an `@`
mention arrives here already expanded to the target's title (`@[[id]]` →
`@Some bullet`), so a bullet whose title *begins* with a variable's name — a
variable `tone` and a bullet called "tone of voice" — has that first word
substituted. Rename one of the two; the "Model input" column shows it happening.

## Bullet kinds

Each node carries a `kind`, which decides what running it does:

| `kind`     | What happens                                                     |
|------------|------------------------------------------------------------------|
| `prompt`   | Sent to the LLM. The default.                                     |
| `template` | Never sent: the rendered text, with every upstream output substituted in, *is* the output. |
| `python`   | Runs the code its **one child** produced, in a **Modal sandbox** — not on this server. |

`template` needs no model type of its own: pbt parses `{{ config(...) }}` into
`model.config` and hands it to `llm_call`, where `llm.py` short-circuits into a
passthrough. `python` cannot work that way — `llm_call` never sees the upstream
outputs, and the code must not run in this process — so `modal_exec.py`
registers a pbt model kind for `model_type="python_modal"`.

A python bullet **holds no code of its own** — it is an operator, not an
editor. Its child's output *is* the program. So one bullet asks an LLM for a
script and the python bullet above it executes that script; nothing a person
typed on the bullet ever reaches the sandbox, and its `text` is ignored
outright. Since such an answer usually arrives fenced and wrapped in prose, the
first ```-fenced block is taken as the program when there is one.

It takes **exactly one** input. Two children would mean two scripts
concatenated into one file, which is nobody's intent, so the editor refuses to
give a python bullet a second child and `POST /run` rejects a graph that
carries one (`@` references count as inputs too). A run that trips this returns
an error and executes nothing.

That output is also readable *by* the program as `inputs` — a list, or
`ref(0)`. Whatever it **prints** is the bullet's output, which is what flows
into the bullets downstream. A non-zero exit becomes an error on the
run, with the traceback — and the line numbers in it are the script's own.

Because its text is inert, a python bullet with nothing beneath it is dropped
from the run like any other empty subtree, rather than failing.

The sandbox image is fixed: `numpy`, `pandas`, `requests`. There is
deliberately no way for a bullet to request more — the code is written
upstream, usually by an LLM, so a package name would be chosen upstream too,
and install-time code runs before the script does.

Attachments never reach a python bullet: the sandbox is a different machine.

`GET /python/enabled` reports whether Modal is configured; the UI hides the
"Convert to python" action when it is not.

`GET /healthz` is a health check. `GET /` serves the built frontend when a
`dist/` folder sits next to `server/` (see Docker below); otherwise it 404s and
the server is API-only.

## Run locally

```bash
cd server
pip install -r requirements.txt
uvicorn main:app --port 8000 --reload
```

Keys are read from the **repo-root `.env`** (loaded by `main.py` at import), or
from the environment, or — for the LLM providers only — sent per request from
the UI. Modal is server-side only:

```ini
GEMINI_API_KEY=...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

`modal token new` (or `modal token set --token-id … --token-secret …`) writes
the same credentials to `~/.modal.toml`, which works just as well.

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
   in the UI is used. Set `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`
   too if `python` bullets should work — there is no UI fallback for those.
4. Open the public URL — the app loads and Run works out of the box.

> If Railway is serving the **static site** instead (`POST /run` → 405,
> `GET /run` returns HTML), the service is using Node static detection rather
> than the Dockerfile. Make sure the service Root Directory is the repo root and
> redeploy; Railway prefers the Dockerfile.

**API-only** (no bundled frontend): set Root Directory to `server`; Railway then
installs `requirements.txt` and runs the `Procfile`. Point a separately-hosted
frontend at it with `VITE_SERVER_URL=…` or a `?server=…` link.

No state is stored between requests, so a single instance scales trivially.

## Model overrides (env)

| Provider  | Key env var         | Model env var (default)             |
|-----------|---------------------|-------------------------------------|
| Gemini    | `GEMINI_API_KEY`    | `GEMINI_MODEL` (`gemini-3.6-flash`) |
| OpenAI    | `OPENAI_API_KEY`    | `OPENAI_MODEL` (`gpt-4o-mini`)      |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (`claude-sonnet-4-5`) |
