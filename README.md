# Workflowy Mind Map

A React app that pairs a **Workflowy-style outliner** with a **live mind map** of
the same tree. Edit bullets on the right; watch them flow as a node graph on the
left. The two views share one state, so a change (or a click) on either side is
reflected on the other.

The mind map is rendered with [`@xyflow/react`](https://reactflow.dev) (React
Flow) — the node-graph library already used by this project.

## Layout

```
┌───────────────────────────┬──────┬──────────────────────┐
│                           │      │  • Welcome           │
│        Mind map           │ drag │      body…           │
│   (React Flow, top → down)│  ⇄   │    • Left is a map   │
│                           │      │    • Right is outline│
└───────────────────────────┴──────┴──────────────────────┘
        left panel          divider     right panel
```

- **Right — outline.** Workflowy-style bullets. Each bullet has a **bold title**
  (first line) and a body underneath. Resize the panel by dragging the divider
  (20–70 % of the screen).
- **Left — mind map.** Top-level bullets sit at the top and flow down to their
  children (many children to one parent). Parent→child links are solid; `@`
  references are dashed. Clicking a node focuses that bullet in the outline.

## Keyboard shortcuts

Focus is shared across both panels — arrow navigation and clicks move the caret
consistently.

| Key | In the title | In the body |
|-----|--------------|-------------|
| `Enter` | Move to the body | Create a new bullet below |
| `Shift+Enter` | — | Insert a newline |
| `Tab` | Indent (nest under previous sibling) | Indent |
| `Shift+Tab` | Outdent | Outdent |
| `Alt+Shift+↑` / `Alt+Shift+↓` | Reorder the bullet up / down | Same |
| `↑` / `↓` | Move focus to the previous / next editor | Same, at line boundaries |
| `Backspace` (empty bullet, at start) | Delete the bullet | Jump up to the title |

So from a bullet's first line, one `Enter` drops into the body, and a second
`Enter` (from the body) creates the bullet underneath — the Workflowy flow.

**Reorder** works like Workflowy: `Alt+Shift+↑`/`↓` moves a bullet among its
siblings, and past the first/last sibling it hops above/below the parent.
Indent/outdent stay on `Tab`/`Shift+Tab`.

## Mind-map interactions

- **Click a node** → focus that bullet in the outline (and vice-versa).
- **Run results** show as a card under each node. **Tap a result card** to
  branch a new child node off that bullet.
- **Delete a link** — tap a link (or select it and press `Delete`/`Backspace`).
  Deleting a parent→child link makes the child a **new top-level node**;
  deleting a dashed reference link just removes the `@` reference.
- **Touch-friendly**: the divider drags with touch, the map pans/pinch-zooms,
  and tap targets grow on touch devices.

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

- **Different node types** — every bullet is a basic prompt node (no
  template/loop types).
- **In-browser execution** (PyScript) and **in-browser LLMs** (WebLLM) — running
  always goes through the server.
- File uploads / promptfiles, per-session storage, and parallel-loop map/reduce.

## References

Type `@` in any title or body to mention another bullet. An autocomplete list of
matching bullets appears; pick one with the arrow keys and `Enter`/`Tab` (or
click). This inserts the bullet's title and draws a **dashed link** from the
current bullet to the referenced one on the mind map.

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
| `src/types.ts` | `Bullet`, `Focus`, `OutlineState` types |
| `src/outline/` | Right panel — outline, bullet rows, `@` autocomplete, focus registry |
| `src/mindmap/` | Left panel — React Flow map, custom node, tree layout |
| `src/lib/` | `mentions` (parse `@`), `caret` (textarea caret helpers) |
| `src/App.tsx` | Split layout + resizable divider |
