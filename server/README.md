# Mind-map runner (FastAPI + pbt)

A tiny, **stateless** server with one meaningful endpoint. It receives the
bullet graph as JSON and returns each bullet's result after flowing through
[prompt-build-tool](https://github.com/conradbez/prompt-build-tool).

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

Each bullet becomes a pbt model. A node **auto-includes its children's outputs**
(children feed up into the parent) plus any explicit `@` references (`refs`) —
both become `{{ ref('…') }}` dependencies. pbt resolves ordering and runs
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

A bullet pbt **skipped** — because something it depends on failed — gets that
said at the top of its entry instead. Its inputs are missing from the
reconstruction because they were never produced, and a prompt that does not
admit it was never sent reads as a bug in whatever fed it.

Errors name a bullet by its first line, not by its pbt model name: `n_gT4b9…` is
the right name for the run and the wrong one for the sentence a person reads
when it fails.

One ambiguity is left standing, since both features share the `@`: an `@`
mention arrives here already expanded to the target's title (`@[[id]]` →
`@Some bullet`), so a bullet whose title *begins* with a variable's name — a
variable `tone` and a bullet called "tone of voice" — has that first word
substituted. Rename one of the two; the "Model input" column shows it happening.

## Enforcing JSON (`jsonOutput`)

A node with `"jsonOutput": true` is emitted with pbt's own
`{{ config(output_format="json") }}`, so pbt **parses and validates** the answer
(stripping any ` ```json ` fence). A bullet that comes back as prose fails with
its parse error rather than passing the prose downstream — that is the part that
makes it *enforcement* rather than a request.

Asking is done too, since validating alone does not make a model comply:

* a **prompt** bullet has `Respond with JSON only — no prose, no code fences.`
  appended to its own text, where the "Model input" column shows it. Template
  and python bullets do not get the line — a template's text *is* its output, so
  an instruction in it would come out in the answer — but they are still
  validated.
* where the provider has a JSON mode, `llm.py` turns it on: Gemini's
  `response_mime_type`, OpenAI's `response_format` (which requires the prompt to
  mention JSON — the appended line is what satisfies it). Anthropic has no such
  mode, so there the instruction and the validation are the whole of it.

**The two forms of a JSON answer.** pbt hands the *parsed* value downstream, and
Jinja writes a parsed value into the next prompt with `str()` — a Python-style
mapping, single quotes and all. So `outputs` shows canonical, pretty-printed
JSON (what a person reads) while `prompts` shows the mapping form (what actually
reached the next model). They differ on purpose: the point of that column is to
say what was really sent.

## Exporting (`POST /export`)

`POST /export` returns the graph as a pbt project you can run without this app.
Same body as `/run` plus a `target`:

```jsonc
{ "target": "script",   // or "project"
  "name": "Ore datasets",
  "nodes": [ ... ], "promptdata": { ... }, "globalInstruction": "..." }
// → { "filename": "ore_datasets_pipeline.py", "text": "...", "warnings": [] }
```

* **`script`** — one file: the models as a dict, a small `llm_call`, and
  `pbt.async_run` over them.
* **`project`** — one file that *writes* `models/<name>.prompt` per bullet plus
  a `client.py`, which is the layout `pbt serve` expects. `pbt serve` cannot be
  handed a dict, so the export has to be the thing that lays the project out.

The sources come from `_build_source`, the same function a run uses, so an
export is the graph **as it actually runs** rather than a second rendering that
can drift. What differs is naming: a run uses `n_<bullet id>`, an export names
each model after its bullet's first line, because these become file names and
`ref('…')` calls a person will read.

`warnings` says what could not come along — attachments (the bytes stay in this
server's bucket) and python bullets (they need the `python_modal` kind, which is
this server's, not pbt's). Nothing is dropped silently.

## Bullet kinds

Each node carries a `kind`, which decides what running it does:

| `kind`     | What happens                                                     |
|------------|------------------------------------------------------------------|
| `prompt`   | Sent to the LLM. The default.                                     |
| `template` | Never sent: the rendered text, with every upstream output substituted in, *is* the output. |
| `python`   | Runs the code its **one child** produced, in a **Modal sandbox** — not on this server. |
| `agent`    | Its rendered text is a **task** for a coding agent (OpenCode) in a Modal sandbox, with its own tools and, optionally, an **MCP server**'s tools. Its output is `{"output", "logs", "run_time"}`. See below. |

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

The sandbox image always has `numpy`, `pandas` and `requests`. Add to it with
**`MODAL_PACKAGES`** on the server:

```ini
MODAL_PACKAGES=scipy, pillow==11.*, beautifulsoup4
```

Comma- or space-separated, each entry a plain requirement — a name, optional
`[extras]`, optional version pin. Anything else (an index URL, a flag, a path, a
git reference) is **refused**, and a python bullet then fails with a message
naming it rather than running with the package quietly missing: that would
surface as an ImportError from a script nobody wrote, a long way from the
environment variable that caused it. The image is held for the life of the
process, so a change needs a restart, and costs one image build on the next run.

### Per-run packages: `python_depn`

A run can add to that image with the **`python_depn`** variable — a fixed
row at the top of the settings table, comma-separated:

```
python_depn = beautifulsoup4, lxml, scipy==1.*
```

The server reads it on the way past and writes it into each python bullet's
config line — `{{ config(model_type="python_modal", packages="…") }}` — so it
travels *in the model source*, not in a module-level variable: the server
answers requests concurrently, and a global would let one run's packages end up
in another's sandbox. Entries are held to the same rule as `MODAL_PACKAGES` (a
name, optional `[extras]`, optional pin) and the bullet fails naming anything
else, rather than passing it to `uv pip install` as an argument.

It stays a variable like any other, so `@python_depn` written into the
prompt that *generates* the script tells the model what it may import, in the
same breath as telling the sandbox what to install.

### A script asking for its own packages: PEP 723

A script may also declare what it needs itself, in the standard
[PEP 723](https://peps.python.org/pep-0723/) inline-metadata block — the one
`uv run` and `pipx run` read:

```python
# /// script
# dependencies = ["httpx", "rich>=13"]
# ///
```

`modal_exec` parses it out of the child's output and installs those on top of
everything else. Using the standard rather than a marker of our own means a
script written here runs unchanged anywhere else, and a model asked for "a PEP
723 header" already knows what that is. A script with no block, or an
unparseable one, asks for nothing: a comment that is not valid metadata is a
comment. A block naming something that is not a requirement fails the bullet.

### `@coding_instructions`

The three things a model writing one of these scripts cannot know — that its
answer is executed rather than read, what is already installed, and how to ask
for more. Put `@coding_instructions` in the prompt that asks for the
script and the server fills it in:

```
Write Python only — the file is run exactly as you write it, so no explanation
outside comments. A ``` fence around it is fine.
These are already installed: numpy, pandas, requests, beautifulsoup4.
For anything else, declare it in a PEP 723 block at the top of the file and it
will be installed before the script runs:

# /// script
# dependencies = ["httpx", "rich"]
# ///
```

It has a fixed row of its own in the variables table, left empty by default. The
server fills an empty one in — the package list is then the real one for this
server and this run, so the default cannot drift from the sandbox it describes
the way a hand-written paragraph would. A value typed into that row is a
deliberate override and is passed through untouched.

Both of these rows are the server's by name: it looks them up by it, so neither
can be renamed or deleted in the table — only filled in. A renamed reserved
variable would simply be one the server never finds, which fails silently.

A per-run package the image already has is dropped rather than reinstalled: an
extra name means a different image, and a different image means a build, for a
package that was there all along.

The packages are part of that bullet's cache key: `{{ config(...) }}` renders to
nothing, so the environment a script ran against is invisible in the rendered
prompt, and the same script against a different environment is a different run.

**This is a real widening of who chooses.** `MODAL_PACKAGES` needs deploy
access; `python_depn` needs only the ability to POST a graph, and `pip`
runs a package's own build code before the script does. On a server anyone can
reach, that is arbitrary code execution in your Modal account. It is off no
switch — if that matters for a deployment, do not expose that server.

`GET /python/enabled` reports the list, because the packages are chosen on the
server while the prompt that writes the script is written in the browser — the
`•••` → *Convert to python* tooltip names them.

Attachments never reach a python bullet: the sandbox is a different machine.

`GET /python/enabled` reports whether Modal is configured (and what the sandbox
has installed); the UI annotates the "Convert to python" action when it is not.

## Agent bullets (`agent`, optionally with an MCP server)

An agent bullet is shaped like a prompt: its text, `@` references filled in
where they stand, children's outputs below, the global instruction on top. But
instead of one model call, that rendered text is sent as one turn to a
[Hermes](https://github.com/NousResearch/hermes-agent) agent on a fresh
[Agent37](https://www.agent37.com/docs/agents-api/desktop) instance. The agent
uses its tools (terminal, files, a browser, any MCP server's) until it answers,
and its final message is the answer. It is emitted as
`{{ config(model_type="agent37", mcp_server="…", steps=…, produces_files=True) }}`,
a kind `agent_exec.py` registers with pbt on import.

```
Agent37 instance    (template `hermes-vnc-desktop`, one per bullet run)
├── Hermes          POST /v1/responses, streamed: each tool call is a log line
├── Chromium        on a visible desktop the agent's browser tool drives
└── noVNC :6901     that desktop, linked from the log by a signed URL
```

One bullet run goes like this:

1. **Create.** `POST /v1/instances` from the template.
2. **Wait.** Poll `/v1/health` until the agent reports healthy.
3. **Link the desktop.** Mint a signed URL for port 6901 and log it as a
   `vnc.html` link.
4. **Configure.** Over exec, `hermes config set` writes the run's provider and
   key (`custom_providers`, `model`), the step limit (`agent.max_turns`) and
   the MCP server (`mcp_servers.task`). With an MCP server, restart the agent
   so it connects.
5. **Run.** Send the task as one streamed turn.
6. **Collect.** For a files bullet, collect `~/outputs/`.
7. **Delete.** Delete the instance, whether the run succeeded or failed.

### One-off: build the template

The desktop template is built once per Agent37 workspace. The build runs on
Agent37, so you don't need Docker:

```bash
git clone https://github.com/agent37-platform/examples
cd examples/custom-images/hermes-vnc-desktop
export AGENT37_API_KEY=sk_live_...
npx agent37 templates build . --name hermes-vnc-desktop --default-port 3737
```

### Watching the agent

While the agent runs, the log has a line like:

```
[    9.1s] desktop: watch the agent's screen: https://ab12cd34ef-6901.agent37.app/vnc.html?a37_token=…&autoconnect=1&resize=scale
```

* **Open it in a top-level tab.** In an iframe it gets 401s, because the
  token's cookie is not sent cross-site.
* **Watch without control.** Add `&view_only=1`.
* **Open it soon.** The link expires after `AGENT37_DESKTOP_TTL_SECONDS` (5
  minutes by default). The token grants full control and can't be revoked.
  The instance is deleted when the bullet ends, so the link is dead after that
  anyway.
* **The agent knows you're watching.** Its task tells it that the person can
  see its screen. When a site needs a sign-in, it says so instead of asking
  for a password in chat.

### The model

The agent uses the **run's provider and key**, the same ones prompt bullets
use. They are written into Hermes' config as a custom provider pointing at
the provider's OpenAI-compatible endpoint (`agent_exec._PROVIDER_URL`).

Agent37 documents instance env (`AGENT37_LLM_PROXY_URL` and friends) for this.
Don't use it: this template rewires the managed model at boot and sends the
token to Agent37's own proxy, which answers `Invalid starter token`.

The key never goes into the model source, where it would land in the cache key
and in exports. `main.run` binds it in a context variable for the tasks pbt
spawns. Set `AGENT37_MANAGED_MODEL=1` to use Agent37's managed model instead,
billed to the workspace within `AGENT37_BUDGET_MICROS`.

### Output

The bullet's output is a JSON object:

```jsonc
{
  "output": "…the agent's answer…",   // parsed, when the bullet enforces JSON
  "logs": [
    "[    0.0s] agent37: creating instance (template hermes-vnc-desktop)",
    "[   38.2s] agent37: instance ab12cd34ef up; waiting for the agent",
    "[   41.0s] desktop: watch the agent's screen: https://ab12cd34ef-6901.agent37.app/vnc.html?a37_token=…",
    "[   41.9s] agent: starting (up to 30 steps), task of 94 chars",
    "[   47.3s] tool: terminal: uname -a",
    "…",
    "[   80.4s] agent: finished, 18402 in / 912 out tokens, $0.0123",
    "[   81.0s] agent37: instance deleted"
  ],
  "run_time": 81.0                    // seconds, instance created → deleted
}
```

Each log line is tagged with where it came from:

| Tag | What it covers |
|---|---|
| `agent37` | the instance being created, restarted and deleted |
| `desktop` | the link to watch the agent's screen |
| `tool` | every tool call, with Hermes' one-line label |
| `agent` | the turn starting and how it finished (tokens, cost) |
| `files` | each file collected from `~/outputs/` |

A log over 400 lines keeps its first and last 200 lines.

With JSON enforced on the bullet, `output` holds the answer *parsed*, and an
answer that won't parse fails the bullet. Everything downstream gets the whole
object, logs included. A failed run fails the bullet, and its error message
ends with the last 40 lines of the log.

### Server-side settings

All are optional except the key:

| Variable | Default | What it sets |
|---|---|---|
| `AGENT37_API_KEY` | (none) | **required**: a `sk_live_` key from a funded Agent37 workspace |
| `AGENT37_TEMPLATE` | `hermes-vnc-desktop` | the template each instance is created from |
| `AGENT37_BUDGET_MICROS` | `1000000` | managed-services credit per instance ($1); compute is billed separately |
| `AGENT37_MANAGED_MODEL` | off | run on Agent37's managed model instead of the run's provider and key |
| `AGENT37_DESKTOP_TTL_SECONDS` | `300` | how long the desktop link opens |
| `AGENT_STEP_LIMIT` | `30` | Hermes' `max_turns` when neither the bullet nor the run sets one |
| `AGENT_TIMEOUT_SECONDS` | `900` | the longest a turn may run before it is cancelled |
| `AGENT37_QUEUE_SECONDS` | `900` | how long a bullet waits for a free instance when the workspace is at its instance limit |
| `AGENT_READY_SECONDS` | `240` | how long a new instance's agent may take to report healthy |

`GET /agent/enabled` reports whether `AGENT37_API_KEY` is set.

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
from the environment. LLM provider keys are the exception: they are only ever
sent per request from the UI, never read from the server. Modal and Agent37 are server-side
only:

```ini
GEMINI_API_KEY=...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
AGENT37_API_KEY=sk_live_...   # agent bullets
MODAL_PACKAGES=scipy, pillow   # optional — on top of numpy/pandas/requests
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
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` (`deepseek/deepseek-v4.1-flash`) |
