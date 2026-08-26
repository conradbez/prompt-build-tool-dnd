# Workflowy Mind Map

A React app that pairs a **Workflowy-style outliner** with a **live mind map** of
the same tree. Edit bullets on the right; watch them flow as a node graph on the
left. The two views share one state, so a change (or a click) on either side is
reflected on the other.

Each bullet is a single markdown text field — rendered when you're not editing
it, raw while you are.

The mind map is rendered with [`@xyflow/react`](https://reactflow.dev) (React
Flow) — the node-graph library already used by this project.

## Layout

```
┌───────────────────────────┬──────┬──────────────────────┐
│                           │      │  • # Find best fruit │
│        Mind map           │ drag │    Using the list…   │
│   (React Flow, top → down)│  ⇄   │    • List 10 fruits  │
│                           │      │    • Assess fruits…  │
└───────────────────────────┴──────┴──────────────────────┘
        left panel          divider     right panel
```

- **Right — outline.** Workflowy-style bullets. Each bullet is **one markdown
  text field** — there is no separate title, so anything that should stand out
  says so in markdown (`# heading`, `**bold**`). The bullet you have the caret
  in shows its raw markdown; every other bullet shows it rendered. Resize the
  panel by dragging the divider (20–70 % of the screen).
- **Left — mind map.** Top-level bullets sit at the top and flow down to their
  children (many children to one parent). Parent→child links are solid; `@`
  references are dashed. Clicking a node focuses that bullet in the outline.

## Keyboard shortcuts

| Key | Does |
|-----|------|
| `Enter` | Create a new bullet below |
| `Shift+Enter` | Insert a newline in this bullet |
| `Tab` / `Shift+Tab` | Indent (nest under previous sibling) / outdent |
| `Alt+Shift+↑` / `Alt+Shift+↓` | Reorder the bullet up / down |
| `↑` / `↓` | Move focus to the previous / next bullet, at line boundaries |
| `Backspace` (empty bullet, at start) | Delete the bullet |

**Reorder** works like Workflowy: `Alt+Shift+↑`/`↓` moves a bullet among its
siblings, and past the first/last sibling it hops above/below the parent.

## Mind-map interactions

**Mouse** — React Flow's own defaults, keybindings included, with one
exception: the `+` circle.

| Gesture | Does |
|---------|------|
| Click a node | Focus that bullet in the outline (and vice-versa) |
| Drag a node | Move it — the node keeps that spot instead of following the auto-layout |
| Drag from the `+` circle | Start a link from that node |
| Drop the link on a node | Link them — see *child vs reference* below |
| Drop the link on empty canvas | Create a new node there, as a child |
| Click the `+` circle | Create a child node — **the exception**: React Flow would start a click-connection here |
| Click a link, then `Backspace` | Remove it — React Flow's own selection and its default delete key (`Backspace`; `Delete` is not bound) |
| Space-drag, scroll, ctrl-scroll | Pan and zoom, per React Flow's defaults |

That `Backspace` never eats an edit: React Flow ignores keypresses while a
textarea has focus — and clicking the canvas takes the caret out of the outline,
which is what lets the binding fire at all.

**Touch** has no keyboard and no hover, so it gets its own set: tap a node to
focus it, drag a node to move it, drag from the `+` circle (always visible on
touch, 26 px across) to start a link — which may end anywhere on the target
node, not just its dot — **tap a link to delete it** (standing in for the
`Backspace` binding), one finger pans and two fingers pinch to zoom.

**Child vs reference.** Dropping a link on a node that has **no parent** makes
it a *child* of the source — dragging a loose node under another one is how you
build the tree. If the target already sits in the tree, you get an `@`
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
*non-child* node. The API key is remembered per provider in this browser's
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

- **Loop nodes** — a bullet is either a prompt or a template (`•••` → *Convert
  to template*), with no map/reduce loop type.
- **In-browser execution** (PyScript) and **in-browser LLMs** (WebLLM) — running
  always goes through the server.
- File uploads / promptfiles, per-session storage, and parallel-loop map/reduce.

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
