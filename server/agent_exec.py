"""
An ``agent`` bullet type: a coding agent in a Modal sandbox, with an optional MCP server.

A prompt bullet asks a model once. An agent bullet hands its rendered text — its
own words plus whatever flowed up from its children and `@` references — to
mini-swe-agent as a task, in a fresh sandbox, and the agent works at it with
bash until it submits an answer. That answer is the bullet's output.

Any stdio MCP server can ride along. Everything lives in the one sandbox:
nothing is hosted and no ports are exposed.

    Modal sandbox
    ├── mcp_daemon.py   main process: launches the MCP server over stdio,
    │                   holds one session open, listens on /tmp/mcp.sock
    ├── mcp-call        tiny CLI; the agent runs it through bash
    └── run_agent.py    mini-swe-agent loop (bash is its only tool)

mini-swe-agent runs each command in a fresh shell, so it cannot hold an MCP
session itself. The daemon holds it, which keeps the server's state alive across
steps; the agent just runs ``mcp-call <tool> '<json>'``. With no MCP server the
sandbox's main process is a plain ``sleep`` and the agent has bash alone.

The server to launch is a per-bullet setting — ``{{ config(model_type=
"agent_modal", mcp_server="uvx some-mcp-server") }}`` — so it travels in the
model source like a python bullet's packages do (see `modal_exec.config_line`).

The model's key does *not*: a key written into the source would end up in the
cache key and in every export. It is carried per run in a context variable set
by ``main.run`` (``use_provider``), which every task pbt spawns inherits, and
reaches the sandbox as a Modal secret built on the spot.

The bullet's output is a JSON object, not bare text:

    {"output": <the agent's answer>, "logs": [...], "run_time": <seconds>}

``logs`` is the run end to end, one line per event with its offset from the
start: the sandbox being created, the MCP server coming up and each tool call it
served, every agent step (its thought, its command, what the command returned),
how the agent finished, and the teardown. ``run_time`` is wall-clock seconds from
creating the sandbox to terminating it. When the bullet has JSON enforced,
``output`` is the answer parsed, and an answer that will not parse fails it.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import pathlib
import re
import shlex
import time
from typing import Any

import pbt
from pbt.executor.run_context import parse_json_output as pbt_json

import modal_exec
from llm import ENV_KEYS, model_name

MODEL_TYPE = "agent_modal"

# The config key naming the MCP server command. Empty means none.
MCP_KEY = "mcp_server"

APP_NAME = os.environ.get("AGENT_APP_NAME", "mindmap-agent")

# Whole-sandbox lifetime, which bounds the agent's run and the server's start.
TIMEOUT_SECONDS = int(os.environ.get("AGENT_TIMEOUT_SECONDS", "900"))
# How long the MCP server may take to come up. A `uvx`/`npx` server downloads
# itself on first start, which is most of this.
MCP_START_SECONDS = int(os.environ.get("AGENT_MCP_START_SECONDS", "180"))
STEP_LIMIT = int(os.environ.get("AGENT_STEP_LIMIT", "30"))
COST_LIMIT = float(os.environ.get("AGENT_COST_LIMIT", "1.0"))
CPU = 2
MEMORY_MB = 4096

# The agent's answer is a bullet's result and travels back to the browser.
MAX_OUTPUT_CHARS = 20_000

# Deployment-only additions to the sandbox image, like `MODAL_PACKAGES` for
# python bullets: system libraries an MCP server needs (`libgl1` for a CAD
# server, say), Python packages, and Modal secrets holding the server's own API
# keys. Server-side and only server-side — nothing that arrives over HTTP picks
# what gets installed or which of your secrets a sandbox can read.
APT_ENV = "AGENT_APT_PACKAGES"
PIP_ENV = "AGENT_PIP_PACKAGES"
SECRETS_ENV = "AGENT_MODAL_SECRETS"

# An apt package name, per Debian policy. Anything else is refused rather than
# handed to `apt-get install` as an argument.
_APT_NAME = re.compile(r"^[a-z0-9][a-z0-9+.-]+$")

AGENT_DIR = pathlib.Path(__file__).resolve().parent / "agent"
SOCK = "/tmp/mcp.sock"
TASK_PATH = "/tmp/agent_task.md"
RESULT_PATH = "/tmp/agent_result.json"
# The daemon's own output — its timestamped request log, and whatever the MCP
# server writes to stderr — teed here so it can be read back while the sandbox
# is still up.
DAEMON_LOG = "/tmp/mcp_daemon.log"

# The log travels back to the browser and on to any bullet downstream. A run
# that goes past this keeps its start and its end, which is where the story is.
MAX_LOG_LINES = 400

# The litellm prefix for each provider this server offers.
_LITELLM_PREFIX = {"gemini": "gemini", "openai": "openai", "anthropic": "anthropic"}

# (provider, key sent from the UI) for the run in progress. A context variable
# rather than a global because the server answers requests concurrently: each
# `/run` sets its own, and the tasks pbt spawns for it inherit that one.
_provider: contextvars.ContextVar[tuple[str, str | None]] = contextvars.ContextVar(
    "agent_provider", default=("gemini", None)
)


def use_provider(provider: str, api_key: str | None) -> contextvars.Token:
    """Bind this run's provider and key for any agent bullet in it."""
    return _provider.set((provider, api_key))


def reset_provider(token: contextvars.Token) -> None:
    _provider.reset(token)


def config_line(mcp_server: str = "") -> str:
    """The bullet's config line, naming its MCP server when it has one.

    The command goes through `json.dumps`, whose escapes Jinja's string
    literals read the same way, so no quote in it can end the literal early.
    """
    command = " ".join(mcp_server.split())
    if not command:
        return '{{ config(model_type="%s") }}' % MODEL_TYPE
    return "{{ config(model_type=\"%s\", %s=%s) }}" % (MODEL_TYPE, MCP_KEY, json.dumps(command))


def enabled() -> bool:
    """Agent bullets run on Modal, so they need what python bullets need."""
    return modal_exec.enabled()


def _split_env() -> tuple[list[str], list[str], list[str]]:
    """The deployment's apt and pip extras, and anything refused among them."""
    apt = [a for a in re.split(r"[,\s]+", os.environ.get(APT_ENV, "").strip()) if a]
    pip, bad_pip = modal_exec.split_requirements(os.environ.get(PIP_ENV, ""))
    bad = [a for a in apt if not _APT_NAME.match(a)] + bad_pip
    return [a for a in apt if _APT_NAME.match(a)], pip, bad


def secrets() -> list[str]:
    return [s for s in re.split(r"[,\s]+", os.environ.get(SECRETS_ENV, "").strip()) if s]


def rejected() -> list[str]:
    """Entries in the deployment's extras that are not package names."""
    return _split_env()[2]


_app = None
_image = None


def _lookup():
    """The Modal app and agent image, created once and reused.

    Deferred rather than done at import, like `modal_exec._lookup`: both hit
    the network, and a server with no Modal credentials must still start.
    """
    global _app, _image
    if _app is None:
        import modal

        apt, pip, _ = _split_env()
        _app = modal.App.lookup(APP_NAME, create_if_missing=True)
        _image = (
            modal.Image.debian_slim(python_version="3.12")
            # Node for `npx` servers, git and curl because an agent reaches for them.
            .apt_install("nodejs", "npm", "git", "curl", *apt)
            # mcp 2.x renamed and changed the client APIs the daemon uses.
            .uv_pip_install("mini-swe-agent>=2.4,<3", "mcp>=1.20,<2", "uv", "pyyaml", *pip)
            .env(
                {
                    # litellm has no price for every model, and mini-swe-agent
                    # stops the run on a model it cannot price unless told not to.
                    "MSWEA_COST_TRACKING": "ignore_errors",
                    "MSWEA_SILENT_STARTUP": "1",
                    "MCP_SOCK": SOCK,
                }
            )
            .add_local_file(AGENT_DIR / "mcp_daemon.py", "/opt/agent/mcp_daemon.py", copy=True)
            .add_local_file(AGENT_DIR / "mcp_call.py", "/usr/local/bin/mcp-call", copy=True)
            .add_local_file(AGENT_DIR / "run_agent.py", "/opt/agent/run_agent.py", copy=True)
            .run_commands("chmod +x /usr/local/bin/mcp-call")
        )
    return _app, _image


def _secret_env(provider: str, api_key: str | None) -> dict[str, str]:
    """What the sandbox needs to call the model: its name and the key.

    litellm reads each provider's own key variable, so the key goes in under
    the same name this server reads it from.
    """
    key = api_key or os.environ.get(ENV_KEYS[provider], "")
    if not key:
        raise RuntimeError(
            f"No API key for '{provider}'. Enter one in the toolbar or set "
            f"{ENV_KEYS[provider]} on the server."
        )
    model = os.environ.get("AGENT_MODEL") or f"{_LITELLM_PREFIX[provider]}/{model_name(provider)}"
    return {
        ENV_KEYS[provider]: key,
        "AGENT_MODEL": model,
        "AGENT_STEP_LIMIT": str(STEP_LIMIT),
        "AGENT_COST_LIMIT": str(COST_LIMIT),
        "MCP_INLINE_IMAGES": os.environ.get("AGENT_INLINE_IMAGES", "1"),
    }


class _Log:
    """The run's events, each at its offset in seconds from the start."""

    def __init__(self) -> None:
        self.t0 = time.time()
        self.events: list[tuple[float, str, str]] = []

    def add(self, source: str, message: str, at: float | None = None) -> None:
        self.events.append(((at if at is not None else time.time()) - self.t0, source, message))

    def lines(self) -> list[str]:
        # Stable, so events stamped the same instant keep the order they came in.
        ordered = sorted(self.events, key=lambda e: e[0])
        out = [f"[{t:7.1f}s] {source}: {message}" for t, source, message in ordered]
        if len(out) > MAX_LOG_LINES:
            keep = MAX_LOG_LINES // 2
            out = out[:keep] + [f"… {len(out) - 2 * keep} lines elided …"] + out[-keep:]
        return out

    def tail(self, n: int = 40) -> str:
        return "\n".join(self.lines()[-n:])


class AgentError(RuntimeError):
    """A failed agent run, with the log up to where it stopped.

    A failure is when the log matters most, and pbt reports a failed bullet by
    its error message alone — so the tail of the log goes into the message.
    """

    def __init__(self, message: str, log: _Log) -> None:
        super().__init__(f"{message}\n\nLog (last lines):\n{log.tail()}")


def _output(sb) -> str:
    """Whatever the sandbox's main process said, for a server that failed to start."""
    parts = []
    for stream in (sb.stderr, sb.stdout):
        try:
            parts.append(stream.read())
        except Exception:  # noqa: BLE001 — best effort, this is an error message
            pass
    return "\n".join(p.strip() for p in parts if p and p.strip())[-4000:]


def _read(sb, path: str) -> str:
    """A file in the sandbox, or "" if it is not there."""
    p = sb.exec("cat", path)
    text = p.stdout.read()
    return text if p.wait() == 0 else ""


def _daemon_events(text: str, offset: float, log: _Log) -> None:
    """Merge the daemon's log in.

    Its own lines carry an epoch timestamp, written when a request *completes*.
    The MCP server's stderr carries none, and whatever it printed happened
    during the request logged next — so it is held and filed just ahead of that
    line. Anything after the last one is filed at the last one.
    """
    pending: list[str] = []
    at = None
    for line in text.splitlines():
        stamp, _, rest = line.partition(" ")
        try:
            at = float(stamp) + offset
        except ValueError:
            if line.strip():
                pending.append(line.rstrip()[:1000])
            continue
        for held in pending:
            log.add("mcp-server", held, at)
        pending = []
        log.add("mcp", rest, at)
    for held in pending:
        log.add("mcp-server", held, at)


def _start_mcp(sb, command: list[str], log: _Log) -> None:
    """Wait for the daemon's socket, then check the server answers at all."""
    log.add("modal", f"starting MCP server: {shlex.join(command)}")
    # Polled from here rather than waited on in the sandbox, so a server that
    # dies on start fails the bullet then, not a whole start timeout later.
    deadline = time.time() + MCP_START_SECONDS
    while True:
        if sb.poll() is not None:
            log.add("mcp-server", _output(sb) or "it printed nothing")
            raise AgentError(f"The MCP server `{shlex.join(command)}` exited while starting.", log)
        if sb.exec("test", "-S", SOCK).wait() == 0:
            break
        if time.time() > deadline:
            raise AgentError(
                f"The MCP server `{shlex.join(command)}` did not come up within {MCP_START_SECONDS}s.",
                log,
            )
        time.sleep(1)
    check = sb.exec("mcp-call", "list")
    listing = check.stdout.read()
    if check.wait() != 0:
        log.add("mcp", (check.stderr.read() or listing).strip()[-2000:])
        raise AgentError(f"The MCP server `{shlex.join(command)}` started but would not list its tools.", log)
    tools = [line.split(" - ", 1)[0] for line in listing.splitlines() if line.strip()]
    log.add("mcp", f"{len(tools)} tools: {', '.join(tools)}")


def _run_sandbox(task: str, mcp_server: str, env: dict[str, str], json_answer: bool) -> dict:
    """Run the agent on *task* in a fresh sandbox. Blocking — call it off the loop."""
    import modal

    log = _Log()
    app, image = _lookup()
    command = shlex.split(mcp_server) if mcp_server.strip() else []
    # `"$@"` hands the server command through untouched — no shell reads it.
    entry = (
        ["sh", "-c", f'python /opt/agent/mcp_daemon.py "$@" 2>&1 | tee {DAEMON_LOG}', "sh", *command]
        if command
        else ["sleep", "infinity"]
    )

    log.add("modal", f"creating sandbox (app {APP_NAME}, {CPU} cpu, {MEMORY_MB} MB, timeout {TIMEOUT_SECONDS}s)")
    sb = modal.Sandbox.create(
        *entry,
        app=app,
        image=image,
        timeout=TIMEOUT_SECONDS,
        workdir="/root",
        cpu=CPU,
        memory=MEMORY_MB,
        secrets=[modal.Secret.from_dict(env), *(modal.Secret.from_name(s) for s in secrets())],
    )
    log.add("modal", f"sandbox {sb.object_id} up")
    result: dict[str, Any] = {}
    offset = 0.0
    try:
        if command:
            _start_mcp(sb, command, log)

        # Through stdin, not argv: a rendered bullet can be long, and nothing
        # in it should be read by a shell.
        put = sb.exec("sh", "-c", f"cat > {TASK_PATH}")
        put.stdin.write(task.encode())
        put.stdin.write_eof()
        put.stdin.drain()
        put.wait()

        log.add("agent", f"starting ({env['AGENT_MODEL']}, up to {STEP_LIMIT} steps), task of {len(task)} chars")
        launched = time.time()
        p = sb.exec("python", "/opt/agent/run_agent.py", TASK_PATH, RESULT_PATH)
        out = p.stdout.read()
        err = p.stderr.read()
        code = p.wait()

        raw = _read(sb, RESULT_PATH)
        if not raw.strip():
            log.add("agent", f"exited {code} without a result:\n{(err or out or '').strip()[-3000:]}")
            raise AgentError(f"The agent exited {code} without a result.", log)
        result = json.loads(raw)
        # The sandbox's clock is not this one. Its events are placed by lining
        # up the agent's own start with the moment it was launched from here.
        offset = launched - float(result.get("started", launched))
        for e in result.get("events", []):
            log.add(e.get("source", "agent"), e.get("message", ""), float(e["ts"]) + offset)
        log.add(
            "agent",
            f"finished: {result.get('exit_status') or 'unknown'} after {result.get('steps', '?')} steps"
            + (f", ${result['cost']:.4f}" if result.get("cost") else ""),
        )
    finally:
        if command:
            try:
                _daemon_events(_read(sb, DAEMON_LOG), offset, log)
            except Exception as exc:  # noqa: BLE001 — a missing log must not hide the real error
                log.add("mcp", f"could not read the daemon log: {exc}")
        sb.terminate()
        log.add("modal", "sandbox terminated")

    return {
        "output": _answer(result, json_answer, log),
        "logs": log.lines(),
        "run_time": round(time.time() - log.t0, 1),
    }


def _answer(result: dict[str, Any], json_answer: bool, log: _Log) -> Any:
    """The submission — parsed, if the bullet enforces JSON — or an error saying
    why there is none."""
    submission = (result.get("submission") or "").strip()
    if result.get("exit_status") == "Submitted" and submission:
        if not json_answer:
            return submission[:MAX_OUTPUT_CHARS]
        try:
            return pbt_json(submission)
        except ValueError as exc:
            raise AgentError(f"The agent's answer is not valid JSON: {exc}", log) from exc
    status = result.get("exit_status") or "an unknown reason"
    said = (result.get("error") or result.get("last_message") or "").strip()[-2000:]
    raise AgentError(
        f"The agent stopped without an answer ({status}, after {result.get('steps', '?')} steps)."
        + (f" Last it said:\n{said}" if said else ""),
        log,
    )


async def _run(task: str, mcp_server: str, env: dict[str, str], json_answer: bool) -> str:
    if not enabled():
        raise RuntimeError(
            "Agent bullets run on Modal, which is not configured on this "
            "server. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET."
        )
    if refused := rejected():
        raise RuntimeError(
            f"{APT_ENV} / {PIP_ENV} list something that is not a package name: "
            f"{', '.join(refused)}. Nothing is run rather than running without it."
        )
    if not task.strip():
        raise RuntimeError("An agent bullet needs a task — its text, or something from below it.")
    # Modal's client is blocking, and pbt runs independent branches
    # concurrently — keep one agent from stalling the others.
    # Serialised here, parsed back in `execute`: `call.compute` caches what it
    # is handed, and text is what a cache stores faithfully.
    result = await asyncio.to_thread(_run_sandbox, task, mcp_server, env, json_answer)
    return json.dumps(result, ensure_ascii=False)


# Registered on import, like `modal_exec`: importing this module is what teaches
# pbt the kind. The rendered text is a task in natural language, so the run's
# global instruction is welcome here.
@pbt.model_kind(MODEL_TYPE, config_keys={MCP_KEY})
async def execute(rendered: str, call: pbt.ModelCall) -> dict:
    """Hand the rendered bullet to a coding agent, with its MCP server if it names one.

    Returns ``{"output", "logs", "run_time"}`` — see the module docstring. A
    structured value, so pbt passes it on as it is rather than parsing it.

    The key is resolved *outside* `call.compute`, so a missing one fails the
    bullet before anything is cached or started, and never enters the cache key.
    """
    mcp_server = str(call.spec.config.get(MCP_KEY, ""))
    provider, api_key = _provider.get()
    env = _secret_env(provider, api_key)

    # `{{ config(...) }}` renders to nothing, so the server and the model are
    # invisible in `rendered` — and the same task with a different toolbox or a
    # different model is a different run.
    json_answer = call.spec.output_format == "json"
    cache_text = "\x00".join([rendered, mcp_server, env["AGENT_MODEL"], str(json_answer)])
    raw = await call.compute(
        cache_text, compute=lambda: _run(rendered.strip(), mcp_server, env, json_answer)
    )
    return json.loads(raw)
