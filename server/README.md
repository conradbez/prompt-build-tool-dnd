# Visual Prompt Map runner (FastAPI + promptmap)

A small server with one meaningful endpoint. It receives the
bullet graph as JSON and returns each bullet's result after flowing through
[promptmap](https://github.com/conradbez/promptmap).

Each person's promptmap run history (the cache, and `{{ previous }}`, which is
how a chat bullet remembers its conversation) lives in its own SQLite file
under `runs/`, next to the accounts database (`DB_PATH`, the Railway volume
when one is attached). The file is keyed by the signed-in email, else the
browser's session id. See `run_store.py`.

## Endpoint

`POST /run`

```jsonc
// request
{
  "provider": "anthropic",          // gemini | openai | anthropic | openrouter
  "apiKey": "sk-...",               // required; the server never uses its own keys
  "promptdata": { "tone": "formal" },  // optional; run variables, see below
  "nodes": [
    { "id": "a", "text": "# Topic\nPick a topic", "refs": [] },
    { "id": "b", "text": "# Tweet\nWrite a tweet about it", "refs": ["a"] }
  ]
}
```

```jsonc
// response — outputs keyed by the bullet id you sent
{ "outputs": { "a": "…", "b": "…" }, "errors": [], "needsKey": false }
```

`needsKey` is the one refusal that happens *before* the graph is built: there
is no `apiKey` for the chosen provider, so nothing ran. Provider keys in the
server's environment are never used — a public deploy can't spend them. The UI flashes its settings gear rather than printing a
failure against every bullet.

Each bullet becomes a promptmap model. A node **auto-includes its children's outputs**
(children feed up into the parent) plus any explicit `@` references (`refs`) —
both become `{{ ref('…') }}` dependencies. promptmap resolves ordering and runs
independent branches in parallel.

An `@` reference is substituted **where it stands**. The mention marks the place
in the sentence that the referenced bullet's answer belongs, so it becomes that
bullet's `{{ ref('…') }}` and the answer is rendered inline — nothing about the
reference is spelled out, because the name was only ever a placeholder for its
content:

```
Which libraries suit these datasets @[[<id>]]
    ↓
Which libraries suit these datasets {"datasets": ["geophysics", "drilling"]}
```

Everything else follows the text:

```
<the bullet's own text, with its @ references filled in>
<child 1's output>
<child 2's output>
<any @ reference that had no place of its own to go>
```

The bullet's own text comes **first** and the material it is about follows, so
"summarise what follows" means what it says. A reference already standing in the
sentence is not also pasted underneath it.

An **empty bullet is not skipped** when anything beneath it has text: a blank
bullet is how you write "hand my children's outputs upward", and a child
reaches the root only through its parent, so dropping it would cut off the
whole branch. Only a subtree that is empty all the way down is skipped.

## Run variables (`promptdata`)

`promptdata` is a flat name → value map for the whole run — the settings table
in the UI is one row per entry. A bullet uses one by writing `@name`, and the
server rewrites each `@name` it recognises into `{{ promptdata("name") }}`
before promptmap renders it, so the value arrives through promptmap's own mechanism rather
than by string-splicing on the way in.

Only **known** names are rewritten. An `@word` matching no variable is left
exactly as typed — it is prose, not a broken reference — and a name that is not
`[A-Za-z0-9_]+` is dropped from the map rather than written into a template.
The `@` must also start a word, so an email address in a prompt is safe.

Variables work in the **global instruction** too, and are the only variable that
can: promptmap refuses `ref()` there (it would make every model depend on one) and
points at `promptdata` instead.

The `prompts` in the response are promptmap's own `prompt_rendered`: exactly
what the model was sent — global instruction, variables filled in, each input
in its `[name]…[/name]` tag — and filled in for a cached answer too. That column
answers "what did the model actually see".

A bullet promptmap **skipped** — because something it depends on failed — or one
that **failed** has no rendered prompt, so its entry says so and shows the
bullet's own text instead.

Models are named after their bullets' titles (`export.model_names`: lowercased,
underscored, unique), so a `[ref]` tag, `org_outline()` and an exported file all
read the way the map does. Errors still name a bullet by its first line as
written.

### Parallelism, caching, outline

Independent bullets run side by side, up to `maxParallel` at once (Settings →
parallel bullets; default 4, at most 8) — agents included, so the cap is also a
cap on concurrent spend. Each `done` event carries promptmap's `cache` label
(`cache`, `cache_check`, or `""` when the bullet ran).

A prompt or agent bullet with `outline: true` gets promptmap's `org_outline()`
after its text: the bullets one step up and down from it, plus the map's final
outputs, as a tree with "[you are here]" on this one.

### Kinds this server allows

Only `""` (LLM), `template`, `agent_modal` and `agent37` stay
registered. Every other kind promptmap or its extras register — `agent`,
`coding_agent`, `execute_python`, `python_modal`, `agent_multi_harness`, `browser_use` — runs
code on *this* machine and is removed at import.

One ambiguity is left standing, since both features share the `@`: an `@`
mention arrives here already expanded to the target's title (`@[[id]]` →
`@Some bullet`), so a bullet whose title *begins* with a variable's name — a
variable `tone` and a bullet called "tone of voice" — has that first word
substituted. Rename one of the two; the "Model input" column shows it happening.

## Enforcing JSON (`jsonOutput`)

A node with `"jsonOutput": true` is emitted with promptmap's own
`{{ config(output_format="json") }}`, so promptmap **parses and validates** the answer
(stripping any ` ```json ` fence). A bullet that comes back as prose fails with
its parse error rather than passing the prose downstream — that is the part that
makes it *enforcement* rather than a request.

Asking is done too, since validating alone does not make a model comply:

* a **chat** or **agent** bullet has `Respond with JSON only — no prose, no code fences.`
  appended to its own text, where the "Model input" column shows it. Template
  bullets do not get the line — a template's text *is* its output, so
  an instruction in it would come out in the answer — but they are still
  validated.
* provider JSON modes (`response_format`) are **not** switched on: models run
  through promptmap's own backend, which has no option for them. The
  instruction and promptmap's validation are the whole of it — a bullet whose
  answer is not JSON fails rather than passing prose on.

Every provider goes through promptmap's own LiteLLM backend
(`promptmap.llm.litellm_llm_call`, with `api_key=` set to the key the request
carried), so attachments reach Gemini, OpenAI, Anthropic and OpenRouter alike,
a bullet's `config(model=…)` is honoured, and token usage comes back as
`promptmap.LLMResult`.

**The two forms of a JSON answer.** promptmap hands the *parsed* value downstream, and
Jinja writes a parsed value into the next prompt with `str()` — a Python-style
mapping, single quotes and all. So `outputs` shows canonical, pretty-printed
JSON (what a person reads) while `prompts` shows the mapping form (what actually
reached the next model). They differ on purpose: the point of that column is to
say what was really sent.

## Exporting (`POST /export`)

`POST /export` returns the graph as a promptmap project you can run without this app.
Same body as `/run` plus a `target`:

```jsonc
{ "target": "script",   // or "project"
  "name": "Ore datasets",
  "nodes": [ ... ], "promptdata": { ... }, "globalInstruction": "..." }
// → { "filename": "ore_datasets_pipeline.py", "text": "...", "warnings": [] }
```

* **`script`** — one file: the models as a dict and `promptmap.async_run` over
  them on promptmap's LiteLLM backend (`litellm_llm_call(PROVIDER, MODEL)`),
  then the test bullets as a `TESTS` dict judged by
  `promptmap.tester.execute_tests`. Tests run after the whole pipeline
  (`async_run` has no gates), and a failing one makes the script exit 1.
* **`project`** — one file that *writes* the project: the models, tests and
  promptdata as promptmap's construct JSON (`promptmap.construct_to_files`),
  plus `settings.yml` (provider + model), `global.prompt`, and a `client.py`
  with `classify_call` only when a test is classifier-judged. That is the layout
  `promptmap run` / `test` / `serve` expect.

No LLM client is generated: promptmap's default backend reads the provider and
model from `settings.yml`, the key from the environment, and a bullet's own
`config(model=…)` — the same key this server uses — so per-bullet models
survive the export.

Test bullets leave as promptmap **tests**, not models (`_native_test_source`):
an LLM judge answers `{"results": "pass"}`, which is promptmap's verdict format,
and a classifier judge gets `config(judge="classifier", threshold=…)`. In a
project every test is a **gate**: `promptmap run` judges it right after the models
it reads and stops the run if it fails. The app never stops a run on a failing
test, so this is the one place an export behaves differently.

The sources come from `_build_source`, the same function a run uses, so an
export is the graph **as it actually runs** rather than a second rendering that
can drift — and both name each model after its bullet's first line.

`warnings` says what could not come along — attachments (the bytes stay in this
server's bucket) and agent bullets (they need the extra model kinds). Nothing
is dropped silently.

## Bullet kinds

Each node carries a `kind`, which decides what running it does:

| `kind`     | What happens                                                     |
|------------|------------------------------------------------------------------|
| `chat`     | Sent to the LLM. The default. Its text is the first message; follow-ups in its popup amend the answer (sent every run, earlier replies are not). |
| `template` | Never sent: the rendered text, with every upstream output substituted in, *is* the output. |
| `search`   | A template whose rendered text is a web search query: `rag_gemini_search` / `rag_openai_search` / `rag_anthropic_search` on the run's provider **and key**, passed as a promptmap secret (see `search.py`), or `rag_brave_search` (server `BRAVE_API_KEY`) for OpenRouter. |
| `agent`    | Its rendered text is a **task** for a coding agent (OpenCode) in a Modal sandbox, with its own tools and, optionally, an **MCP server**'s tools. Its output is `{"output", "logs", "run_time"}`. See below. |

`template` is promptmap's built-in passthrough kind: `llm_call` is never
called.

## Agent bullets (`agent`, optionally with an MCP server)

An agent bullet is shaped like a prompt — its text, `@` references filled in
where they stand, children's outputs below, the global instruction on top — but
instead of one model call, that rendered text is handed to
[OpenCode](https://opencode.ai), run headless, as a task. The agent works in a
fresh Modal sandbox with its own tools (bash, reading and editing files, …) and
any MCP server's until it answers; its final message is the answer.

The bullet's output is a JSON object:

```jsonc
{
  "output": "…the agent's answer…",   // parsed, when the bullet enforces JSON
  "logs": [
    "[    0.0s] modal: creating sandbox (app mindmap-agent, 2 cpu, 4096 MB, timeout 900s)",
    "[    1.2s] modal: sandbox sb-… up",
    "[    1.2s] modal: starting MCP server: uvx counter-mcp",
    "[    1.2s] agent: starting (anthropic/claude-sonnet-4-5, up to 30 steps), task of 94 chars",
    "[    6.9s] mcp: server connected in 5.6s",
    "[    9.4s] agent: step 1: I'll bump the counter by 3.",
    "[    9.5s] mcp: step 1 mcp_bump {\"by\": 3} -> completed\ncounter=3",
    "[   10.8s] tool: step 2 $ ls /root -> completed\nopencode.json",
    "…",
    "[   21.2s] agent: finished: Answered after 4 steps, $0.0123",
    "[   21.3s] modal: sandbox terminated"
  ],
  "run_time": 21.3                    // seconds, sandbox created → terminated
}
```

`logs` is the run end to end, one line per event at its offset from the start.
Each line is tagged with where it came from:

| Tag | What |
|---|---|
| `modal` | the sandbox being created and terminated, and the MCP server being started |
| `mcp` | the server coming up, and every call to one of its tools, with its arguments, status and output |
| `tool` | every call to one of OpenCode's own tools (`$ command` for bash), with its status and output |
| `agent` | each step's text, any error, and how the run finished (status, steps, cost) |

The sandbox's clock and this server's are lined up by the moment the agent is
launched. Each step's text is clipped (600 chars of reasoning, 1,500 of output),
an image a tool returned is logged as `[N image(s) shown to the model]`, and a log
over 400 lines keeps its first and last 200. It is a summary of the run: the
model saw everything.

The object is returned to promptmap as a structured value, so it passes on as one,
and `outputs` shows it as pretty-printed JSON. With JSON enforced on the bullet,
the agent is asked for JSON and `output` holds the answer *parsed*; an answer
that won't parse fails the bullet.

**Everything downstream gets the whole object, logs included.** A parent bullet,
or an `@` reference to an agent bullet, renders it in full, so the logs go into
that prompt as well. That's the point when the next bullet is meant to judge
the run. When it only needs the answer, it costs tokens.

A failed run doesn't produce the object: the bullet fails, so promptmap skips what
depends on it. Its error message ends with the last 40 lines of the log.

A node may name an **MCP server**: any command that starts one over stdio.

```jsonc
{ "id": "a", "kind": "agent", "text": "Make a 60x40x6mm plate…",
  "mcpServer": "uvx --python 3.12 build123d-mcp@latest" }
```

It is emitted as `{{ config(model_type="agent_modal", mcp_server="…") }}`, a
kind `agent_exec.py` registers with promptmap on import. Everything lives inside one
sandbox — nothing is hosted and no ports are exposed:

```
Modal sandbox       (main process: a plain `sleep`)
└── run_agent.py    writes /root/opencode.json, checks the MCP server comes up
                    (`opencode mcp list`), runs `opencode run --format json`
                    with the task on stdin, and folds its events into a result
```

OpenCode is an MCP client itself. It launches the server over stdio and holds
one session for the whole run, which keeps the server's state (open files, CAD
sessions, DB connections) alive across steps, and hands the model the server's
tools as `mcp_<tool>` next to its own. With **no** MCP server the agent has
OpenCode's tools alone. The source is `server/agent/run_agent.py`; OpenCode's
version is pinned in `agent_exec.py` (`OPENCODE_VERSION`), since the log and
the answer are read from its JSON event stream.

| Server type | `mcpServer` |
|---|---|
| Python package (PyPI) | `uvx package-name` |
| Node package (npm) | `npx -y @scope/server …args` |
| Needs system libraries / API keys | the same, plus `AGENT_APT_PACKAGES` / `AGENT_MODAL_SECRETS` below |

The agent uses the **run's provider and key** — the same ones prompt bullets
use, as OpenCode's `<provider>/<*_MODEL>` (Gemini is `google/…` there). The
key never goes into the model source (it would land in the cache key and in
exports): `main.run` binds it in a context variable for the tasks promptmap spawns,
and it reaches the sandbox as a Modal secret made for that one sandbox. The MCP server inherits the sandbox's
environment, key included — the agent can read it anyway.

A server that will not start fails the bullet before the agent runs, with
OpenCode's reason and what the server printed when started on its own. An
agent that ends without an answer (a model error, a crash) fails the bullet
with its exit status and the last thing it said, rather than passing on half an
answer. The MCP server's own stderr is otherwise not in the log: OpenCode keeps
it.

Images a tool returns are **shown to the model**: OpenCode passes them on as
image blocks. That needs a vision-capable model, and every image stays in the
conversation — each costs tokens on every later step — so the agent is told to
ask for renders sparingly.

Server-side settings, all optional:

| Variable | Default | |
|---|---|---|
| `AGENT_MODEL` | provider's model | an OpenCode `provider/model` id, overriding the run's provider for every agent |
| `AGENT_STEP_LIMIT` | `30` | steps before the model is told to stop using tools and answer — an instruction, not a cutoff |
| `AGENT_TIMEOUT_SECONDS` | `900` | the sandbox's whole lifetime, the limit that always holds |
| `AGENT_MCP_START_SECONDS` | `180` | how long an MCP server may take to come up (`uvx`/`npx` download first) |
| `AGENT_APT_PACKAGES` | — | system packages an MCP server needs, e.g. `libgl1 libxrender1` |
| `AGENT_PIP_PACKAGES` | — | extra Python packages in the agent image |
| `AGENT_MODAL_SECRETS` | — | Modal secret names attached to every agent sandbox, for an MCP server's own keys |

The image and the secrets are the **deployment's** to
choose; nothing that arrives over HTTP adds to them. The MCP command itself does
arrive over HTTP — it runs inside the sandbox, which also runs whatever commands
the agent picks, so the sandbox is the boundary: don't attach a secret to it you
would mind the agent reading.

`GET /agent/enabled` reports whether Modal is configured for them.

`GET /healthz` is a health check. `GET /` serves the built frontend when a
`dist/` folder sits next to `server/` (see Docker below); otherwise it 404s and
the server is API-only.

## Run locally

```bash
cd server
uv sync
uv run uvicorn main:app --port 8000 --reload
```

Keys are read from the **repo-root `.env`** (loaded by `main.py` at import), or
from the environment. LLM provider keys are the exception: they are only ever
sent per request from the UI, never read from the server. Modal is server-side
only:

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
   too if `agent` bullets should work — there is no UI fallback for those.
4. Open the public URL — the app loads and Run works out of the box.

> If Railway is serving the **static site** instead (`POST /run` → 405,
> `GET /run` returns HTML), the service is using Node static detection rather
> than the Dockerfile. Make sure the service Root Directory is the repo root and
> redeploy; Railway prefers the Dockerfile.

**API-only** (no bundled frontend): set Root Directory to `server`; Railway then
installs `pyproject.toml` and runs the `Procfile`. Point a separately-hosted
frontend at it with `VITE_SERVER_URL=…` or a `?server=…` link.

No state is stored between requests, so a single instance scales trivially.

## Model overrides (env)

| Provider  | Key env var         | Model env var (default)             |
|-----------|---------------------|-------------------------------------|
| Gemini    | `GEMINI_API_KEY`    | `GEMINI_MODEL` (`gemini-3.6-flash`) |
| OpenAI    | `OPENAI_API_KEY`    | `OPENAI_MODEL` (`gpt-4o-mini`)      |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (`claude-sonnet-4-5`) |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` (`deepseek/deepseek-v4.1-flash`) |
