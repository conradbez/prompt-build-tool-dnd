"""
An ``agent`` bullet type: a Hermes agent on an Agent37 instance, with an optional MCP server.

A prompt bullet asks a model once. An agent bullet hands its rendered text — its
own words plus whatever flowed up from its children and `@` references — to
Hermes as a task, on a fresh Agent37 instance, and the agent works at it with
its tools (terminal, files, a browser, …) until it answers. That answer is the
bullet's output.

    Agent37 instance    (template `hermes-vnc-desktop`, created per bullet run)
    ├── Hermes          answers POST /v1/responses, streamed back as events
    ├── Chromium        on a visible desktop the agent's browser tool drives
    └── noVNC :6901     that desktop, watchable from a signed URL

The instance is the sandbox Modal used to be: created when the bullet starts,
deleted when it ends. While it runs, the log carries a signed link to its
desktop (see `_desktop_url`), so a person can watch the agent browse and take
over for a sign-in.

The template is built once per Agent37 workspace (see server/README.md):

    git clone https://github.com/agent37-platform/examples
    cd examples/custom-images/hermes-vnc-desktop
    npx agent37 templates build . --name hermes-vnc-desktop --default-port 3737

Any stdio MCP server can ride along: a per-bullet setting — ``{{ config(
model_type="agent37", mcp_server="uvx some-mcp-server") }}`` — written into
Hermes' ``mcp_servers`` before the task is sent.

The model's key does *not* travel in the source: a key written there would end
up in the cache key and in every export. It is carried per run in a context
variable set by ``main.run`` (``use_run``), with the run's step limit and where
its live log lines go, and is written into Hermes' config as a custom provider
pointing at the provider's OpenAI-compatible endpoint.

The bullet's output is a JSON object, not bare text:

    {"output": <the agent's answer>, "logs": [...], "run_time": <seconds>}

``logs`` is the run end to end, one line per event with its offset from the
start: the instance being created, every tool call, how the agent finished,
and the teardown. When the bullet has JSON enforced, ``output`` is the answer
parsed, and an answer that will not parse fails it.

A bullet set to produce files (``produces_files=True``) also has ``files``: the
agent is told to save them in ``~/outputs/``, and each one it saved comes back
as a ``pbt.File`` — handed to the bullets downstream as attachments.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import shlex
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import httpx
import pbt
from pbt.executor.run_context import parse_json_output as pbt_json

from llm import model_name

MODEL_TYPE = "agent37"

# The config key naming the MCP server command. Empty means none.
MCP_KEY = "mcp_server"
# The config key holding the bullet's own step limit. Absent means the run's.
STEPS_KEY = "steps"
# The config key saying the bullet must hand on files, not only text.
FILES_KEY = "produces_files"

API = os.environ.get("AGENT37_API_URL", "https://api.agent37.com/v1")
API_KEY_ENV = "AGENT37_API_KEY"
TEMPLATE = os.environ.get("AGENT37_TEMPLATE", "hermes-vnc-desktop")
# A cap on what one instance may spend on Agent37's managed services (web
# search, and the model when AGENT37_MANAGED_MODEL is set). Compute is billed
# apart from it, by the minute, while the instance lives.
BUDGET_MICROS = int(os.environ.get("AGENT37_BUDGET_MICROS", "1000000"))
# Run on Agent37's managed model, billed to the workspace, instead of the run's
# own provider and key.
MANAGED_MODEL = os.environ.get("AGENT37_MANAGED_MODEL", "").lower() in ("1", "true", "yes")

# Where an agent asked for files saves them. Relative to the instance user's home.
OUTPUTS_DIR = "~/outputs"
# What is collected from it. Files travel to every bullet downstream and back
# to the browser, so a run that saves more keeps the first ones and says so.
MAX_FILES = int(os.environ.get("AGENT_MAX_FILES", "10"))
MAX_FILES_BYTES = int(os.environ.get("AGENT_MAX_FILES_BYTES", str(20 * 1024 * 1024)))

# The longest a turn may run before it is cancelled and the bullet fails.
TIMEOUT_SECONDS = int(os.environ.get("AGENT_TIMEOUT_SECONDS", "900"))
# How long a bullet waits for a free instance when the workspace is at its
# instance limit (a plan of one runs agent bullets one at a time).
QUEUE_SECONDS = int(os.environ.get("AGENT37_QUEUE_SECONDS", "900"))
# How long a new instance's agent may take to report healthy.
READY_SECONDS = int(os.environ.get("AGENT_READY_SECONDS", "240"))
# Steps (model turns) Hermes may take. The default; a run may ask for another
# within MAX_STEP_LIMIT (Settings → agent steps).
STEP_LIMIT = int(os.environ.get("AGENT_STEP_LIMIT", "30"))
MAX_STEP_LIMIT = int(os.environ.get("AGENT_MAX_STEP_LIMIT", "200"))

# The noVNC port of the desktop template, and how long its link opens it for.
# The token in it grants full control and cannot be revoked, so it is short —
# it only has to be valid when the tab connects — and the instance it opens is
# deleted when the bullet ends anyway.
DESKTOP_PORT = 6901
DESKTOP_TTL_SECONDS = int(os.environ.get("AGENT37_DESKTOP_TTL_SECONDS", "300"))

# The agent's answer is a bullet's result and travels back to the browser.
MAX_OUTPUT_CHARS = 20_000
# The log travels back to the browser and on to any bullet downstream. A run
# that goes past this keeps its start and its end, which is where the story is.
MAX_LOG_LINES = 400
# How much of a tool call's label goes into a log line.
LABEL_CHARS = 300

# Each provider's OpenAI-compatible endpoint, which Hermes is pointed at as a
# custom provider (see `_configure`).
_PROVIDER_URL = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}
# The custom provider's name in Hermes' config.
PROVIDER_NAME = "Run"
# The key variable Hermes' built-in provider reads, for a provider it handles
# itself whatever the config says: an `openrouter.ai` URL goes through its own
# OpenRouter client, which ignores the custom provider's key and fails `401
# User not found` without this.
_HERMES_KEY_ENV = {"openrouter": "OPENROUTER_API_KEY"}

FINISHING = """

---

## How to finish

You work on a Linux machine with a terminal, files and a web browser. The
person can see your browser's screen: if a site needs them (a sign-in, a code,
a CAPTCHA), say so and stop rather than asking for a password in chat.
{mcp}
You have about {steps} steps; leave the last of them for the answer rather
than running out mid-task.
Your final message is what the person reads, so make it the answer itself —
not a description of what you did or where you put it.
"""

FILES_NOTE = """
This task must produce files. Save every file the person should get — images,
documents, data — in {outputs}/ (it exists already). They are handed on as
files, so save at least one; your final message is handed on as text beside
them, so say what each file is rather than pasting its contents.
"""

MCP_NOTE = """
Tools from the MCP server `task` stay up for the whole run, so state carries
over from one call to the next.
"""

# A live log line for one bullet: (pbt model name, line).
LogSink = Callable[[str, str], None]


@dataclass(frozen=True)
class RunSettings:
    """What an agent bullet takes from the run it is part of."""

    provider: str = "gemini"
    api_key: str | None = None
    # Settings → `llm_model`; None means the server's default for the provider.
    model: str | None = None
    # Settings → agent steps; clamped by `steps_for`.
    steps: int = STEP_LIMIT
    # Where each log line goes the moment it happens, for the live run log.
    on_log: LogSink | None = None


# The run in progress. A context variable rather than a global because the
# server answers requests concurrently: each `/run` sets its own, and the tasks
# pbt spawns for it (and the threads they start) inherit that one.
_settings: contextvars.ContextVar[RunSettings] = contextvars.ContextVar(
    "agent_settings", default=RunSettings()
)


def use_run(settings: RunSettings) -> contextvars.Token:
    """Bind this run's provider, key, step limit and log sink for any agent bullet in it."""
    return _settings.set(settings)


def reset_run(token: contextvars.Token) -> None:
    _settings.reset(token)


def steps_for(requested: int | None) -> int:
    """A step limit a run may ask for: the default when it names none."""
    if not requested or requested < 1:
        return STEP_LIMIT
    return min(int(requested), MAX_STEP_LIMIT)


def config_line(mcp_server: str = "", steps: int = 0, produces_files: bool = False) -> str:
    """The bullet's config line, naming its MCP server, step limit and whether
    it hands on files, each only when set.

    The command goes through `json.dumps`, whose escapes Jinja's string
    literals read the same way, so no quote in it can end the literal early.
    """
    args = ['model_type="%s"' % MODEL_TYPE]
    command = " ".join(mcp_server.split())
    if command:
        args.append("%s=%s" % (MCP_KEY, json.dumps(command)))
    if steps and steps > 0:
        args.append("%s=%d" % (STEPS_KEY, int(steps)))
    if produces_files:
        args.append("%s=True" % FILES_KEY)
    return "{{ config(%s) }}" % ", ".join(args)


def enabled() -> bool:
    """Whether an Agent37 key is configured. Instances cost money, so the key
    is the server's alone — nothing is read from the browser."""
    return bool(os.environ.get(API_KEY_ENV))


def rejected() -> list[str]:
    """Kept for `/agent/enabled`'s shape: Agent37 has no deployment extras to vet."""
    return []


@dataclass(frozen=True)
class _Provider:
    """The run's model, as Hermes' custom provider: endpoint, key, model id."""

    base_url: str
    api_key: str
    model: str
    # Also written to ~/.hermes/.env under this name — see `_HERMES_KEY_ENV`.
    key_env: str | None = None


def _provider(provider: str, api_key: str | None, model: str | None) -> _Provider | None:
    """The run's provider and key for Hermes, or None for Agent37's managed model.

    A *model* the person chose wins over the provider's default, so an agent
    bullet answers with the same model as the prompt bullets around it.
    """
    if MANAGED_MODEL:
        return None
    if not api_key:
        raise RuntimeError(f"No API key for '{provider}'. Enter one in settings.")
    if provider not in _PROVIDER_URL:
        raise RuntimeError(f"Agent bullets cannot run on '{provider}'.")
    return _Provider(
        _PROVIDER_URL[provider], api_key, model or model_name(provider), _HERMES_KEY_ENV.get(provider)
    )


class _Log:
    """The run's events, each at its offset in seconds from the start."""

    def __init__(self, on_line: Callable[[str], None] | None = None) -> None:
        self.t0 = time.time()
        self.lines_: list[str] = []
        self.on_line = on_line

    def add(self, source: str, message: str) -> None:
        line = f"[{time.time() - self.t0:7.1f}s] {source}: {message}"
        self.lines_.append(line)
        if self.on_line:
            try:
                self.on_line(line)
            except Exception:  # noqa: BLE001 — a log line is never worth failing the run
                pass

    def lines(self) -> list[str]:
        out = self.lines_
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


class _Instance:
    """One Agent37 instance: the Sandbox API by id, the Agent API by its URL."""

    def __init__(self, client: httpx.Client, key: str, data: dict) -> None:
        self.client = client
        self.key = key
        self.id = data["id"]
        self.url = data["url"].rstrip("/")

    def _api(self, method: str, path: str, **kw) -> dict:
        r = self.client.request(
            method, f"{API}/instances/{self.id}{path}",
            headers={"Authorization": f"Bearer {self.key}"}, **kw,
        )
        _raise_for(r)
        return r.json()

    def _agent(self, method: str, path: str, **kw) -> httpx.Response:
        r = self.client.request(method, f"{self.url}{path}", headers={"X-Agent37-Key": self.key}, **kw)
        _raise_for(r)
        return r

    def exec(self, command: str) -> dict:
        return self._api("POST", "/exec", json={"command": command}, timeout=800)

    def wait_healthy(self, seconds: float) -> None:
        deadline = time.time() + seconds
        while True:
            try:
                r = self.client.get(f"{self.url}/v1/health", headers={"X-Agent37-Key": self.key}, timeout=10)
                if r.status_code == 200 and r.json().get("healthy") is True:
                    return
            except (httpx.HTTPError, ValueError):
                pass
            if time.time() > deadline:
                raise RuntimeError(f"the agent was not healthy after {seconds:.0f}s")
            time.sleep(2)

    def delete(self) -> None:
        self.client.delete(f"{API}/instances/{self.id}", headers={"Authorization": f"Bearer {self.key}"}, timeout=60)


def _raise_for(r: httpx.Response) -> None:
    if r.status_code < 400:
        return
    try:
        err = r.json().get("error") or {}
        detail = f"{err.get('code', '')}: {err.get('message', '')}".strip(": ")
    except ValueError:
        detail = r.text[:500]
    raise RuntimeError(f"Agent37 {r.request.method} {r.request.url.path} → {r.status_code} {detail}")


def _create(client: httpx.Client, key: str, log: _Log) -> dict:
    """Create the instance, waiting for a free slot while the workspace is at
    its instance limit: another agent bullet, or one still being deleted."""
    deadline = time.time() + QUEUE_SECONDS
    waiting = False
    while True:
        r = client.post(
            f"{API}/instances",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "template": TEMPLATE,
                "name": "mindmap-agent",
                "budget": {"credit_micros": BUDGET_MICROS},
            },
            timeout=600,
        )
        limited = r.status_code == 409 and "instance_limit" in r.text
        if not limited or time.time() > deadline:
            _raise_for(r)
            return r.json()
        if not waiting:
            log.add("agent37", "at the workspace's instance limit; waiting for a free slot")
            waiting = True
        time.sleep(10)


def _desktop_url(inst: _Instance) -> str:
    """A signed link to the instance's desktop, at noVNC's page rather than `/`."""
    signed = inst._api("POST", "/signed-url", json={"port": DESKTOP_PORT, "ttl_seconds": DESKTOP_TTL_SECONDS})
    u = urlparse(signed["url"])
    token = parse_qs(u.query)["a37_token"][0]
    return f"https://{u.netloc}/vnc.html?a37_token={token}&autoconnect=1&resize=scale"


def _configure(
    inst: _Instance, steps: int, mcp_server: str, want_files: bool, provider: _Provider | None, log: _Log
) -> None:
    """Set the model, step limit and MCP server with Hermes' own `config set`;
    restart Hermes if a server was added, since it connects its MCP servers
    when it starts.

    The template's interpreters have no `yaml`, and `hermes mcp add` waits on a
    prompt, so the config is written key by key. A value is parsed as YAML,
    which is how the provider and the args go in as a list.

    The provider goes into the config rather than the instance env: the
    template rewires the managed model from `AGENT37_*` at every boot, and
    sends whatever token it finds there to Agent37's own proxy.
    """
    command = shlex.split(mcp_server) if mcp_server.strip() else []
    sets = [("agent.max_turns", str(steps))]
    if provider:
        sets += [
            ("custom_providers", json.dumps([{
                "name": PROVIDER_NAME,
                "base_url": provider.base_url,
                "api_key": provider.api_key,
                "api_mode": "chat_completions",
                "model": provider.model,
            }])),
            ("model.provider", f"custom:{PROVIDER_NAME}"),
            ("model.default", provider.model),
        ]
    if command:
        sets += [
            ("mcp_servers.task.command", command[0]),
            ("mcp_servers.task.args", json.dumps(command[1:])),
        ]
    setup = " && ".join(f"hermes config set {k} {shlex.quote(v)}" for k, v in sets)
    if provider and provider.key_env:
        line = shlex.quote(f"{provider.key_env}={provider.api_key}")
        setup += f" && printf '%s\\n' {line} >> \"$(hermes config env-path)\""
    if want_files:
        setup += f" && mkdir -p {OUTPUTS_DIR}"
    out = inst.exec(setup + " < /dev/null")
    if out.get("exit_code") != 0:
        said = (out.get("stderr") or out.get("stdout") or "").strip()[-2000:]
        if provider:
            said = said.replace(provider.api_key, "<key>")
        raise AgentError(f"Configuring the agent failed: {said}", log)
    if provider:
        log.add("agent37", f"model: {provider.model} at {provider.base_url}")
    if command:
        log.add("agent37", f"MCP server set: {shlex.join(command)}; restarting the agent to connect it")
        inst._api("POST", "/restart", json={})
        # The ack comes before the agent goes down: give it a moment, or the
        # old process answers the health check.
        time.sleep(10)
        inst.wait_healthy(READY_SECONDS)
        log.add("agent37", "agent back up")


def _task(task: str, steps: int, has_mcp: bool, want_files: bool) -> str:
    text = task + FINISHING.format(mcp=MCP_NOTE if has_mcp else "", steps=steps)
    if want_files:
        text += FILES_NOTE.format(outputs=OUTPUTS_DIR)
    return text


def _stream_turn(inst: _Instance, task: str, log: _Log) -> dict:
    """Send *task* as one streamed turn; log each tool call; return the terminal event."""
    body = {"input": task, "stream": True}
    timeout = httpx.Timeout(connect=30, read=240, write=60, pool=30)
    deadline = time.time() + TIMEOUT_SECONDS
    response_id = None
    with inst.client.stream(
        "POST", f"{inst.url}/v1/responses", json=body,
        headers={"X-Agent37-Key": inst.key}, timeout=timeout,
    ) as r:
        if r.status_code >= 400:
            r.read()
            _raise_for(r)
        event = None
        for line in r.iter_lines():
            if time.time() > deadline:
                if response_id:
                    inst._agent("POST", f"/v1/responses/{response_id}/cancel")
                raise AgentError(f"The agent ran past {TIMEOUT_SECONDS}s and was stopped.", log)
            if not line or line.startswith(":"):
                continue
            if line.startswith("event:"):
                event = line[6:].strip()
                continue
            if not line.startswith("data:"):
                continue
            try:
                data = json.loads(line[5:])
            except ValueError:
                continue
            if event == "response.created":
                response_id = data.get("id")
            elif event == "response.tool_call.started":
                label = (data.get("label") or "").strip().replace("\n", " ")
                log.add("tool", f"{data.get('tool')}" + (f": {label[:LABEL_CHARS]}" if label else ""))
            elif event == "response.tool_call.failed":
                log.add("tool", f"{data.get('tool')} failed: {data.get('error') or ''}")
            elif event in ("response.completed", "response.failed"):
                return {"event": event, **data}
    raise AgentError("The agent's stream ended without a result.", log)


def _run_instance(
    task: str,
    mcp_server: str,
    provider: _Provider | None,
    steps: int,
    json_answer: bool,
    on_line: Callable[[str], None] | None = None,
    want_files: bool = False,
) -> dict:
    """Run the agent on *task* on a fresh instance. Blocking — call it off the loop."""
    key = os.environ[API_KEY_ENV]
    log = _Log(on_line)
    files: list[pbt.File] = []
    with httpx.Client(timeout=60) as client:
        log.add("agent37", f"creating instance (template {TEMPLATE})")
        inst = _Instance(client, key, _create(client, key, log))
        try:
            log.add("agent37", f"instance {inst.id} up; waiting for the agent")
            inst.wait_healthy(READY_SECONDS)
            try:
                log.add("desktop", f"watch the agent's screen: {_desktop_url(inst)}")
            except Exception as exc:  # noqa: BLE001 — the run does not need the view
                log.add("desktop", f"no desktop link: {exc}")
            _configure(inst, steps, mcp_server, want_files, provider, log)

            log.add("agent", f"starting (up to {steps} steps), task of {len(task)} chars")
            done = _stream_turn(inst, _task(task, steps, bool(mcp_server.strip()), want_files), log)
            if done["event"] == "response.failed":
                err = done.get("error") or {}
                raise AgentError(f"The agent failed: {err.get('code', '')} {err.get('message', '')}".strip(), log)
            usage = done.get("usage") or {}
            log.add(
                "agent",
                "finished"
                + (f", {usage.get('input_tokens', 0)} in / {usage.get('output_tokens', 0)} out tokens" if usage else "")
                + (f", ${usage['cost_usd']:.4f}" if usage.get("cost_usd") else ""),
            )
            answer = _answer(done.get("output_text") or "", json_answer, log)
            if want_files:
                files = _collect_files(inst, log)
        finally:
            try:
                inst.delete()
                log.add("agent37", "instance deleted")
            except Exception as exc:  # noqa: BLE001
                log.add("agent37", f"could not delete instance {inst.id}: {exc}")

    out: dict[str, Any] = {"output": answer}
    if want_files:
        out["files"] = files
    return {**out, "logs": log.lines(), "run_time": round(time.time() - log.t0, 1)}


def _collect_files(inst: _Instance, log: _Log) -> list[pbt.File]:
    """The files the agent saved in OUTPUTS_DIR, as pbt files.

    Subfolders are flattened into the name (`plots/a.png` → `plots_a.png`):
    pbt file names never carry a path. A bullet that promised files and saved
    none fails, because everything downstream is waiting to be handed them.
    """
    listing = inst.exec(f"cd {OUTPUTS_DIR} && find . -type f -printf '%s\\t%P\\n'").get("stdout", "")
    found = []
    for line in listing.splitlines():
        size, _, rel = line.partition("\t")
        if rel and size.isdigit():
            found.append((rel, int(size)))
    found.sort()
    if not found:
        raise AgentError(
            f"This bullet is set to produce files, but the agent saved none in {OUTPUTS_DIR}/.", log
        )

    files: list[pbt.File] = []
    taken: set[str] = set()
    total = 0
    for rel, size in found:
        if len(files) >= MAX_FILES or total + size > MAX_FILES_BYTES:
            log.add("files", f"skipped {rel} ({size} bytes): over the limit of {MAX_FILES} files / {MAX_FILES_BYTES} bytes")
            continue
        data = inst._agent("GET", "/v1/files/content", params={"path": f"{OUTPUTS_DIR}/{rel}"}, timeout=300).content
        name = rel.replace("/", "_")
        stem, dot, ext = name.rpartition(".")
        n = 2
        while name in taken:
            name = f"{stem}_{n}{dot}{ext}" if dot else f"{ext}_{n}"
            n += 1
        taken.add(name)
        total += len(data)
        files.append(pbt.File(data, name=name))
        log.add("files", f"collected {name} ({len(data)} bytes)")
    return files


def _answer(text: str, json_answer: bool, log: _Log) -> Any:
    """The answer — parsed, if the bullet enforces JSON — or an error saying
    why there is none."""
    text = text.strip()
    if not text:
        raise AgentError("The agent finished without an answer.", log)
    if not json_answer:
        return text[:MAX_OUTPUT_CHARS]
    try:
        return pbt_json(text)
    except ValueError as exc:
        raise AgentError(f"The agent's answer is not valid JSON: {exc}", log) from exc


async def _run(
    task: str,
    mcp_server: str,
    provider: _Provider | None,
    steps: int,
    json_answer: bool,
    on_line: Callable[[str], None] | None = None,
    want_files: bool = False,
) -> dict:
    if not enabled():
        raise RuntimeError(
            f"Agent bullets run on Agent37, which is not configured on this server. Set {API_KEY_ENV}."
        )
    if not task.strip():
        raise RuntimeError("An agent bullet needs a task — its text, or something from below it.")
    # The client is blocking, and pbt runs independent branches concurrently —
    # keep one agent from stalling the others.
    # Returned as it is: pbt's cache stores a dict — and the files in it, by
    # hash — and hands the same back on a hit.
    return await asyncio.to_thread(
        _run_instance, task, mcp_server, provider, steps, json_answer, on_line, want_files
    )


# Registered on import: importing this module is what teaches pbt the kind. The
# rendered text is a task in natural language, so the run's global instruction
# is welcome here.
@pbt.model_kind(MODEL_TYPE, config_keys={MCP_KEY, STEPS_KEY, FILES_KEY})
async def execute(rendered: str, call: pbt.ModelCall) -> dict:
    """Hand the rendered bullet to a Hermes agent, with its MCP server if it names one.

    Returns ``{"output", "logs", "run_time"}`` — see the module docstring. A
    structured value, so pbt passes it on as it is rather than parsing it.

    The key is resolved *outside* `call.compute`, so a missing one fails the
    bullet before anything is cached or started, and never enters the cache key.
    """
    mcp_server = str(call.spec.config.get(MCP_KEY, ""))
    run = _settings.get()
    # The bullet's own limit, if it set one, over the run's.
    try:
        own = int(call.spec.config.get(STEPS_KEY) or 0)
    except (TypeError, ValueError):
        own = 0
    steps = steps_for(own) if own > 0 else run.steps
    provider = _provider(run.provider, run.api_key, run.model)
    name = call.spec.name
    want_files = bool(call.spec.config.get(FILES_KEY))
    on_line = (lambda line: run.on_log(name, line)) if run.on_log else None

    json_answer = call.spec.output_format == "json"
    # Keyed on `rendered` exactly: pbt stores the result under the key it builds
    # from the rendered prompt, so any other text here is looked up but never
    # found. The MCP server, steps, files and chosen model are all in the
    # bullet's `config()`, which pbt already folds into that key.
    raw = await call.compute(
        rendered,
        compute=lambda: _run(rendered.strip(), mcp_server, provider, steps, json_answer, on_line, want_files),
    )
    # An entry cached before results were returned as dicts is JSON text.
    return raw if isinstance(raw, dict) else json.loads(raw)
