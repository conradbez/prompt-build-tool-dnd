# prompt-build-tool DnD

Drag-and-drop DAG editor for [pbt](https://github.com/conradbez/prompt-build-tool).

## Start

**Backend** (from `dnd_server/`):
```bash
cd dnd_server
GEMINI_API_KEY=your_key uvicorn main:app --port 8000 --reload
```

Use the env var matching your provider:

| Provider  | Env var             |
|-----------|---------------------|
| Gemini    | `GEMINI_API_KEY`    |
| OpenAI    | `OPENAI_API_KEY`    |
| Anthropic | `ANTHROPIC_API_KEY` |

The server uses the env var automatically — no need to enter the key in the UI. You can still override it per-run by entering a key in the UI.

**Frontend** (from repo root):
```bash
yarn dev
```

Open [http://localhost:5173](http://localhost:5173).

## Modes

Set `USE_SERVER` in `src/api.ts`:

- `false` — PyScript mode (runs in browser, no backend needed, no file support)
- `true` — Server mode (requires backend, enables prompt file uploads)
