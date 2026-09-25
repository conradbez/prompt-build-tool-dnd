"""The agent inside an agent bullet's sandbox: OpenCode, run headless.

Usage: run_agent.py <task file> <result file> [MCP server command…]

The task arrives as a file rather than an argument because it is a rendered
bullet — upstream answers and all — and has no business being limited by argv.
It reaches OpenCode on stdin. The result is written as JSON to *result file*.

OpenCode speaks MCP itself: the server whose command follows the result file
is launched over stdio, held open for the whole run (so its state carries from
one call to the next), and its tools reach the model as `mcp_<tool>`, next to
OpenCode's own bash, read, edit and the rest. Images a tool returns are shown
to the model.

Model and key come from the environment (`AGENT_MODEL`, as OpenCode's
`provider/model`, and the provider's own key variable, which OpenCode reads) —
set by `agent_exec.py` per run.
"""
import json
import os
import re
import subprocess
import sys
import time

WORKDIR = "/root"
# OpenCode finds its project, and so its config, by $PWD rather than the
# process's actual directory — an inherited PWD would lose the MCP server.
OPENCODE_ENV = {**os.environ, "PWD": WORKDIR}
# The MCP server's name in OpenCode's config, which prefixes its tools.
MCP_NAME = "mcp"

FINISHING = """

---

## How to finish

You work in a Linux sandbox; your working directory is /root. Python 3.12,
`uv`/`uvx`, Node (`npx`), git and curl are installed.
{mcp}
Your final message is what the person reads, so make it the answer itself —
not a description of what you did or where you put it.
"""

MCP_NOTE = """
Tools named `mcp_*` come from an MCP server that stays up for the whole run, so
state carries over from one call to the next. Images they return are shown to
you, and each one costs tokens for the rest of the run: ask for renders or
screenshots only at key steps.
"""

# How much of each step goes into the bullet's log. The log is for following
# what happened, not a transcript: the model saw everything, the log a summary.
THOUGHT_CHARS = 600
OUTPUT_CHARS = 1500

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + f"… [{len(text) - limit} more chars]"


def _config(mcp_command: list[str]) -> dict:
    config = {
        "$schema": "https://opencode.ai/config.json",
        "model": os.environ["AGENT_MODEL"],
        "autoupdate": False,
        "share": "disabled",
        "snapshot": False,
        # No one is there to answer a permission prompt.
        "permission": {"*": "allow"},
        # Past this many steps the model is told to stop using tools and answer.
        "agent": {"build": {"steps": int(os.environ.get("AGENT_STEP_LIMIT", "30"))}},
    }
    if mcp_command:
        config["mcp"] = {
            MCP_NAME: {
                "type": "local",
                "command": mcp_command,
                # Per request. OpenCode's default is 5s; renders and exports are slow.
                "timeout": int(os.environ.get("AGENT_MCP_TIMEOUT_MS", "300000")),
            }
        }
    return config


def _check_mcp(events: list[dict]) -> str | None:
    """Start the MCP server once to see that it comes up. The problem, or None.

    OpenCode would otherwise carry on without a server that failed and leave
    the agent to find out it has no tools.
    """
    started = time.time()
    try:
        p = subprocess.run(
            ["opencode", "mcp", "list"], cwd=WORKDIR, env=OPENCODE_ENV, capture_output=True, text=True,
            timeout=int(os.environ.get("AGENT_MCP_START_SECONDS", "180")),
        )
    except subprocess.TimeoutExpired:
        return "it did not come up in time"
    # A status line (`✓ mcp connected`, `✗ mcp failed`), then its details, each
    # on a line of its own under a `|` gutter.
    lines = _ANSI.sub("", p.stdout + p.stderr).splitlines()
    for i, line in enumerate(lines):
        status = re.search(rf"([✓✗])\s+{MCP_NAME}\s+(\S+)", line)
        if not status:
            continue
        if status.group(1) == "✓":
            events.append({"ts": time.time(), "source": "mcp", "message": f"server {status.group(2)} in {time.time() - started:.1f}s"})
            return None
        detail = []
        for more in lines[i + 1:]:
            if not more.startswith("|") or not more.strip(" |"):
                break
            detail.append(more.strip(" |"))
        return status.group(2) + (": " + "\n".join(detail) if detail else "")
    return "\n".join(lines).strip() or f"opencode mcp list exited {p.returncode}"


def _server_stderr(command: list[str]) -> str:
    """What the server prints when started on its own, for one that failed.

    OpenCode only reports that the connection closed; why (a package that is
    not on the index, a missing library) is on the server's stderr. With stdin
    closed a working server exits at once, and a broken one has already said
    what is wrong.
    """
    try:
        p = subprocess.run(command, cwd=WORKDIR, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        # Both streams: a launcher like uv says "Installed N packages" on
        # stderr, and a server that exits at once often explains on stdout.
        return "\n".join(s.strip() for s in (p.stderr, p.stdout) if s.strip())[-2000:]
    except subprocess.TimeoutExpired as e:
        said = e.stderr or ""
        return (said.decode(errors="replace") if isinstance(said, bytes) else said).strip()[-2000:]
    except OSError as e:
        return str(e)


def _tool_event(part: dict, step: int, ts: float) -> dict:
    tool = part.get("tool", "?")
    state = part.get("state") or {}
    args = state.get("input") or {}
    call = f"$ {args['command']}" if tool == "bash" and "command" in args else f"{tool} {json.dumps(args)}"
    body = state.get("output") if state.get("status") == "completed" else state.get("error")
    images = sum(1 for a in state.get("attachments") or [] if str(a.get("mime", "")).startswith("image/"))
    message = f"step {step} {_clip(call, OUTPUT_CHARS)} -> {state.get('status', '?')}"
    if body:
        message += "\n" + _clip(str(body), OUTPUT_CHARS)
    if images:
        message += f"\n[{images} image(s) shown to the model]"
    source = "mcp" if tool.startswith(MCP_NAME + "_") else "tool"
    started = (state.get("time") or {}).get("start")
    return {"ts": started / 1000 if started else ts, "source": source, "message": message}


def _read_run(lines: list[str], result: dict) -> None:
    """Fold OpenCode's JSON event stream into *result*: the log, the answer,
    steps and cost.

    The answer is the text of the last step, when that step ended the turn
    rather than asking for tools.
    """
    events = result["events"]
    step, cost = 0, 0.0
    texts: dict[str, list[str]] = {}
    last_finish: dict = {}
    errors = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        part = e.get("part") or {}
        ts = e.get("timestamp", time.time() * 1000) / 1000
        kind = e.get("type")
        if kind == "step_start":
            step += 1
        elif kind == "text" and part.get("text", "").strip():
            texts.setdefault(part.get("messageID", ""), []).append(part["text"])
            at = (part.get("time") or {}).get("start")
            events.append({"ts": at / 1000 if at else ts, "source": "agent", "message": f"step {step}: {_clip(part['text'], THOUGHT_CHARS)}"})
        elif kind == "tool_use":
            events.append(_tool_event(part, step, ts))
        elif kind == "step_finish":
            cost += float(part.get("cost") or 0)
            last_finish = part
        elif kind == "error":
            err = e.get("error") or {}
            errors.append(f"{err.get('name', 'Error')}: {(err.get('data') or {}).get('message', '')}".strip())
            events.append({"ts": ts, "source": "agent", "message": f"error {errors[-1]}"})

    answer = "\n".join(texts.get(last_finish.get("messageID", ""), [])).strip()
    said = [t for group in texts.values() for t in group]
    result.update(steps=step, cost=cost, last_message=said[-1] if said else "")
    if errors:
        result.update(exit_status="Error", error="\n".join(errors))
    elif last_finish.get("reason") == "stop" and answer:
        result.update(exit_status="Answered", submission=answer)
    else:
        result.update(exit_status=f"Stopped ({last_finish.get('reason') or 'no step finished'})")


def main(task_path: str, result_path: str, mcp_command: list[str]) -> None:
    result: dict = {"started": time.time(), "model": os.environ["AGENT_MODEL"], "exit_status": "", "submission": "", "events": []}
    with open(task_path) as f:
        task = f.read()
    with open(os.path.join(WORKDIR, "opencode.json"), "w") as f:
        json.dump(_config(mcp_command), f, indent=2)

    try:
        problem = _check_mcp(result["events"]) if mcp_command else None
        if problem:
            said = _server_stderr(mcp_command)
            result.update(exit_status="MCPServerFailed", steps=0, error=problem + (f"\nIt printed:\n{said}" if said else ""))
            return
        task += FINISHING.format(mcp=MCP_NOTE if mcp_command else "")
        # --title skips a model call spent naming the session.
        p = subprocess.run(
            ["opencode", "run", "--format", "json", "--auto", "--title", "agent bullet"],
            cwd=WORKDIR, env=OPENCODE_ENV, input=task, capture_output=True, text=True,
        )
        _read_run(p.stdout.splitlines(), result)
        if p.returncode and not result.get("error") and result["exit_status"] != "Answered":
            result["error"] = f"opencode exited {p.returncode}:\n{p.stderr.strip()[-3000:]}"
    except Exception as e:  # noqa: BLE001 — reported back, not swallowed
        result.update(exit_status=type(e).__name__, error=str(e))
    finally:
        with open(result_path, "w") as f:
            json.dump(result, f)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
