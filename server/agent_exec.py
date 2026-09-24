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
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import pathlib
import re
import shlex
from typing import Any

import pbt

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


def _output(sb) -> str:
    """Whatever the sandbox's main process said, for a server that failed to start."""
    parts = []
    for stream in (sb.stderr, sb.stdout):
        try:
            parts.append(stream.read())
        except Exception:  # noqa: BLE001 — best effort, this is an error message
            pass
    return "\n".join(p.strip() for p in parts if p and p.strip())[-4000:]


def _start_mcp(sb, command: list[str]) -> None:
    """Wait for the daemon's socket, then check the server answers at all."""
    wait = sb.exec(
        "sh",
        "-c",
        f"for i in $(seq {MCP_START_SECONDS}); do [ -S {SOCK} ] && exit 0; sleep 1; done; exit 1",
    )
    if wait.wait() != 0 or sb.poll() is not None:
        detail = _output(sb) if sb.poll() is not None else "it is still starting"
        raise RuntimeError(
            f"The MCP server `{shlex.join(command)}` did not come up within "
            f"{MCP_START_SECONDS}s — {detail or 'it printed nothing'}"
        )
    check = sb.exec("mcp-call", "list")
    listing = check.stdout.read()
    if check.wait() != 0:
        raise RuntimeError(
            f"The MCP server `{shlex.join(command)}` started but would not list "
            f"its tools: {(check.stderr.read() or listing).strip()[-2000:]}"
        )


def _run_sandbox(task: str, mcp_server: str, env: dict[str, str]) -> str:
    """Run the agent on *task* in a fresh sandbox. Blocking — call it off the loop."""
    import modal

    app, image = _lookup()
    command = shlex.split(mcp_server) if mcp_server.strip() else []
    entry = ["python", "/opt/agent/mcp_daemon.py", *command] if command else ["sleep", "infinity"]

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
    try:
        if command:
            _start_mcp(sb, command)

        # Through stdin, not argv: a rendered bullet can be long, and nothing
        # in it should be read by a shell.
        put = sb.exec("sh", "-c", f"cat > {TASK_PATH}")
        put.stdin.write(task.encode())
        put.stdin.write_eof()
        put.stdin.drain()
        put.wait()
        p = sb.exec("python", "/opt/agent/run_agent.py", TASK_PATH, RESULT_PATH)
        log = p.stdout.read()
        err = p.stderr.read()
        code = p.wait()

        read = sb.exec("cat", RESULT_PATH)
        raw = read.stdout.read()
        if read.wait() != 0 or not raw.strip():
            detail = (err or log or "").strip()[-4000:]
            raise RuntimeError(f"The agent exited {code} without a result:\n{detail}")
        result = json.loads(raw)
    finally:
        sb.terminate()

    return _answer(result)


def _answer(result: dict[str, Any]) -> str:
    """The submission, or an error saying why there is none."""
    submission = (result.get("submission") or "").strip()
    if result.get("exit_status") == "Submitted" and submission:
        return submission[:MAX_OUTPUT_CHARS]
    status = result.get("exit_status") or "an unknown reason"
    said = (result.get("error") or result.get("last_message") or "").strip()[-2000:]
    raise RuntimeError(
        f"The agent stopped without an answer ({status}, after "
        f"{result.get('steps', '?')} steps)." + (f" Last it said:\n{said}" if said else "")
    )


async def _run(task: str, mcp_server: str, env: dict[str, str]) -> str:
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
    return await asyncio.to_thread(_run_sandbox, task, mcp_server, env)


# Registered on import, like `modal_exec`: importing this module is what teaches
# pbt the kind. The rendered text is a task in natural language, so the run's
# global instruction is welcome here.
@pbt.model_kind(MODEL_TYPE, config_keys={MCP_KEY})
async def execute(rendered: str, call: pbt.ModelCall) -> str:
    """Hand the rendered bullet to a coding agent, with its MCP server if it names one.

    The key is resolved *outside* `call.compute`, so a missing one fails the
    bullet before anything is cached or started, and never enters the cache key.
    """
    mcp_server = str(call.spec.config.get(MCP_KEY, ""))
    provider, api_key = _provider.get()
    env = _secret_env(provider, api_key)

    # `{{ config(...) }}` renders to nothing, so the server and the model are
    # invisible in `rendered` — and the same task with a different toolbox or a
    # different model is a different run.
    cache_text = "\x00".join([rendered, mcp_server, env["AGENT_MODEL"]])
    return await call.compute(cache_text, compute=lambda: _run(rendered.strip(), mcp_server, env))
