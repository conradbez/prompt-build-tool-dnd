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
| `↑` / `↓` | Move focus to the previous / next editor | Same, at line boundaries |
| `Backspace` (empty bullet, at start) | Delete the bullet | Jump up to the title |

So from a bullet's first line, one `Enter` drops into the body, and a second
`Enter` (from the body) creates the bullet underneath — the Workflowy flow.

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
