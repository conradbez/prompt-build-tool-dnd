# Workflowy Mind Map

A React app that pairs a **Workflowy-style outliner** with a **live mind map** of
the same tree. Work in whichever one suits the moment and switch with a key;
they share one state, so a change (or a click) in either is reflected in the
other.

Each bullet is a single markdown text field — rendered when you're not editing
it, raw while you are.

The mind map is rendered with [`@xyflow/react`](https://reactflow.dev) (React
Flow) — the node-graph library already used by this project.

## Layout

One view fills the window; the other is parked top-right as a live thumbnail
with a ⇄ button above it.

```
┌──────────────────────────────────────────┬────────┐
│  provider · key · Run                    │   ⇄    │
│                                          ├────────┤
│                                          │ ┌────┐ │
│          the view you are in             │ │mini│ │
│      (mind map, or the outline)          │ └────┘ │
│                                          │        │
└──────────────────────────────────────────┴────────┘
```

Swap them by pressing `⌘\` / `Ctrl+\`, clicking the ⇄ button, or clicking the
thumbnail itself. Both views stay mounted and share one store, so the small one
keeps up with whatever you do in the big one.

## Keyboard shortcuts

| Key | Does |
|-----|------|
| `Enter` | Create a new bullet below |
| `Shift+Enter` | Insert a newline in this bullet |
| `Tab` / `Shift+Tab` | Indent (nest under previous sibling) / outdent |
| `Alt+Shift+↑` / `Alt+Shift+↓` | Reorder the bullet up / down |
| `↑` / `↓` | Move focus to the previous / next bullet, at line boundaries |
| `Backspace` (empty bullet, at start) | Delete the bullet |
| `⌘\` / `Ctrl+\` | Switch between the mind map and the outline |

**Reorder** works like Workflowy: `Alt+Shift+↑`/`↓` moves a bullet among its
siblings, and past the first/last sibling it hops above/below the parent.

## Mind-map interactions

**Mouse** — React Flow's own defaults, keybindings included, with one
exception: the `+` circle.

| Gesture | Does |
|---------|------|
| Click a node | Focus that bullet in the outline (and vice-versa) |
| Drag a node | Move it — the node keeps that spot instead of following the auto-layout |
| Drag from the `+` circle | Start a link into that node (the `+` is its input) |
| Drag from the right dot | Link this node's output into another node |
| Drop the link on a node | Link them — see *child vs reference* below |
| Drop the link on empty canvas | Create a new node there, as a child |
| Click the `+` circle | Create a child node — **the exception**: React Flow would start a click-connection here |
| Click a link | Remove it — the link goes red under the pointer to say so |
| Space-drag, scroll, ctrl-scroll | Pan and zoom, per React Flow's defaults |

A link is the one thing on the canvas whose click has nothing else to mean — a
node's click focuses its bullet, the `+` circle adds a child — so it needs no
select-then-delete step.

**Touch** has no keyboard and no hover, so it gets its own set: tap a node to
focus it, drag a node to move it, drag from the `+` circle (always visible on
touch, 26 px across) to start a link — which may end anywhere on the target
node, not just its dot — **tap a link to delete it** (it asks first: a
stray tap is likelier than a stray click, and there is no hover to warn you
which link you are about to lose), one finger pans and two fingers pinch to zoom.

**Links point the way data runs.** A child runs first and feeds its parent, so
it sits *left of* the parent: its link leaves its right dot and enters the `+`
on the parent's left side.

**Child vs reference.** Linking a node that has **no parent** into another
makes it a *child* of that node — linking a loose node in is how you build the
tree. If the target already sits in the tree, you get an `@`
reference instead (a dashed link), leaving its existing parent alone.

**Deleting a link.** Deleting a parent→child link makes the child a **new
top-level node**; deleting a dashed reference link just removes the `@`
reference from the source bullet's text.

## Running the graph (prompt-build-tool)

Top-left there's a small toolbar: pick a **provider** (Gemini / OpenAI /
Anthropic), paste an **API key**, and hit **Run**. The bullet graph is sent to a
tiny stateless FastAPI server (`server/`) that flows it through
[prompt-build-tool](https://github.com/conradbez/prompt-build-tool) and returns
each bullet's result, which is shown under its node on the mind map.

Each bullet becomes one pbt model. A node **auto-includes its children's
outputs** — children run first and feed up into the parent — and any `@`
references you add. These become `{{ ref('…') }}` dependencies that pbt resolves
(running independent branches in parallel). So `@` is only needed to reference a
*non-child* node.

An `@` reference is filled in **where you wrote it**: it marks the spot the
referenced bullet's answer belongs, so that answer is rendered in its place —
you get the content, not the name. A child's output, which has no such spot,
goes below the text. The API key is remembered per provider in this browser's
`localStorage` and sent with the request.

- **Server + Railway deploy:** see [`server/README.md`](server/README.md). The
  repo-root `Dockerfile` deploys **one service** that serves the app and the API
  together, so the deployed URL works with no extra config (recommended).
- **Dev:** the Vite dev server proxies `/api/*` → `http://localhost:8000`, so
  running the server locally needs no extra config.
- **Deployed frontend:** the API URL defaults to the **page's own origin**, so a
  frontend served by the server (the Dockerfile above) posts to `/run` on the
  same URL with no configuration. For a separately-hosted frontend, override it
  with `VITE_SERVER_URL` at build time or a `?server=https://…` link.

### Deliberately left out

To keep this simple, several main-branch features are **not** implemented:

- **In-browser execution** (PyScript) and **in-browser LLMs** (WebLLM) — running
  always goes through the server.
- Per-session storage.

## Python sandbox packages

`•••` → *Convert to python* runs a bullet's child's script in a Modal sandbox,
which always has `numpy`, `pandas` and `requests`. Add to it per run with the
**`python_depn`** row at the top of the Settings variables table —
comma-separated, e.g. `beautifulsoup4, lxml`. It is a variable like any other,
so `@python_depn` in the prompt that writes the script also tells the
model what it may import.

A script can also ask for its own, in the standard **PEP 723** block that
`uv run` reads — declared at the top of the file, installed before it runs:

```python
# /// script
# dependencies = ["httpx", "rich"]
# ///
```

And **`@coding_instructions`** drops the whole convention into the
prompt that asks for the script: that the answer is executed rather than read,
which packages the sandbox already has, and that PEP 723 block. Its row is left
empty by default and the server writes it at run time, so it always names the
real sandbox — type into it to say your own thing instead.

Both rows are fixed: the server looks them up by name, so they cannot be renamed
or deleted, only filled in.

Note what per-run packages mean: anyone who can post a graph to the server
chooses what gets installed, and `pip` runs a package's own build code.
`MODAL_PACKAGES` on the server is the deploy-access-only version — see
[`server/README.md`](server/README.md).

## Saving and exporting

Everything lives in Settings (`⚙`), under **This map**:

Two verbs, and everything else is a choice of *where*:

| | |
|---|---|
| **Save** | keeps this map in this browser under the name in the dropdown — and **opens** it: from then on your edits go into it as you make them |
| **Save ▴** | **Export to pbt** (a `.py` running `pbt.async_run` over every bullet) · **Export to server** (a `.py` that writes `models/*.prompt` + `client.py`, the layout `pbt serve` expects) · **Copy to clipboard** as JSON |
| **Load** | puts the named save back on screen |
| **Load ▴** | JSON on the clipboard |

Saving or loading a name makes that save the document you are working in, and
edits flow back into it (coalesced, not per keystroke) — a save that goes stale
the moment you carry on typing is a save you cannot trust. Nothing is open until
you save or load one; a map pasted from the clipboard opens nothing, since it is
not any of the saves.

Loading replaces what is on screen, so the button asks first — and keeps the map
it replaced as *“Before last load”*, so there is always one step back. The
question lapses after ten seconds rather than sitting there waiting to catch a
later click.

Both exports are built by the server from the same sources a run uses, so what
you take away is what was running — see [`server/README.md`](server/README.md).
A browser that will not hand over the clipboard gets a box to paste into
instead, rather than a button that appears to do nothing.

## Agents with MCP tools

`•••` → **Convert to agent** marks a bullet `AGENT`. Its text — with its inputs
filled in, exactly as a prompt's would be — becomes a **task** for a coding
agent ([OpenCode](https://opencode.ai), run headless) working in a Modal
sandbox. It uses its tools (bash, reading and editing files) until it answers.
The bullet's output is a JSON object: `output` (the answer), `logs` (the whole
run, timestamped, from sandbox start to teardown: every step, command and MCP
tool call) and `run_time` (in seconds). Bullets downstream receive all of it,
logs included.

`•••` → **Set MCP server…** gives the agent any stdio MCP server's tools as
well: type the command that starts it (`uvx some-mcp-server`,
`npx -y @scope/server`), and the chip becomes `AGENT+MCP`. Leave it empty for
an agent with bash alone. The agent uses the provider and key in the toolbar.
See [`server/README.md`](server/README.md) for the sandbox layout and what the
server can configure.

## Enforcing JSON

`•••` → **Enforce JSON output** marks a bullet `JSON`. The server emits pbt's
`{{ config(output_format="json") }}` for it, so the answer is **parsed and
validated**: one that is not JSON fails that bullet with its parse error instead
of flowing downstream as prose. A prompt bullet also gets a line asking for JSON
appended to its text (visible in the *Model input* column), and the provider's
own JSON mode is switched on where it has one.

It is orthogonal to the bullet's kind — a prompt, a template or a python bullet
can each be held to JSON — so it is a chip of its own beside `TPL`/`PY` rather
than a fourth kind. See [`server/README.md`](server/README.md) for how a JSON
answer reaches the *next* bullet, which is not quite how it reads in the panel.

## Attaching files

With a bucket configured, `•••` → **Attach file…** puts a file on a bullet. It
is uploaded to an S3-compatible bucket and sent to the model along with *that
bullet's* prompt — attachments are scoped to the bullet, not the document.

Every object is written under `bullets/<bulletId>/…`, and a run only hands a
bullet the objects sitting under its own prefix. pbt's `promptfiles` are a flat
namespace, so that prefix check is what stops one bullet's files leaking into
another's prompt: the server emits
`{{ config(promptfiles='["…"]') }}` for the keys a bullet actually owns, and
pbt routes the matching files to that model's `llm_call(files=…)`.

Configure the bucket with the standard AWS environment variables — Railway's
bucket variables map straight onto them:

```bash
AWS_ENDPOINT_URL=https://…
AWS_S3_BUCKET_NAME=…
AWS_DEFAULT_REGION=auto
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
```

Locally they go in `.env` (git-ignored) next to your model key. Without them
`GET /files/enabled` reports `false` and the UI simply doesn't offer attaching.
Uploads are capped at 20 MB, and only **Gemini** currently receives the file
bytes — the other providers raise a clear error rather than silently dropping
an attachment from the prompt.

## References

Type `@` in any bullet to mention another one. An autocomplete list of matching
bullets appears; pick one with the arrow keys and `Enter`/`Tab` (or click). This
draws a **dashed link** from the current bullet to the referenced one.

What gets stored is the target's **id**, not its text — a mention survives the
target being retyped, reordered or re-parented. The editor shows the first 10
characters of the target's first line in a different colour; hover it for the
full line. Because the text owns the reference, deleting the mention deletes the
link, and cutting the link on the map deletes the mention.

## Develop

```bash
yarn install
yarn dev      # http://localhost:5173
```

## Build (static, no server)

```bash
yarn build    # outputs to dist/
```

Open `dist/index.html` directly or deploy the folder to any static host.

## Structure

| Path | Responsibility |
|------|----------------|
| `src/store.ts` | Shared bullet-tree state + actions (the single source of truth) |
| `src/types.ts` | `Bullet` (one `text` field), `Focus`, `OutlineState` types |
| `src/outline/` | Right panel — outline, bullet rows, `@` autocomplete, focus registry |
| `src/mindmap/` | Left panel — React Flow map, custom node, tree layout |
| `src/lib/` | `mentions` (`@` tokens ⇄ labels), `markdown` (tiny md → HTML), `caret` (textarea caret helpers) |
| `src/App.tsx` | Split layout + resizable divider |
