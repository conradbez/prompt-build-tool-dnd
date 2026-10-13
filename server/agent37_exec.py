"""
An agent bullet whose disk outlives the run: a Hermes agent on an Agent37 instance
kept for that bullet.

The Modal agent (`agent_exec`) starts from a blank sandbox every run. A bullet
set to *preserve disk between runs* instead gets one Agent37 instance of its
own, found again by name on every run: started if stopped, created on its first
run, and stopped — not deleted — when the run ends. Whatever the agent left on
disk (a checkout, installed tools, notes to itself) is there next time.

    Agent37 instance    (template `hermes-vnc-desktop`, one per bullet, kept)
    ├── Hermes          answers POST /v1/responses, streamed back as events
    ├── Chromium        on a visible desktop the agent's browser tool drives
    └── noVNC :6901     that desktop, watchable from a signed URL

A stopped instance bills disk only. Delete it on Agent37 to start the bullet
over from a blank disk.

It is emitted as ``{{ config(model_type="agent37", disk="<bullet id>") }}``.
MCP servers, files, the Modal browser and back-off are the Modal agent's and
are not offered here; the step limit is.

The run's provider, key, steps and log sink come from `agent_exec`'s run
context, which `main.run` binds for every agent bullet alike.

The template is built once per Agent37 workspace (see server/README.md):

    git clone https://github.com/agent37-platform/examples
    cd examples/custom-images/hermes-vnc-desktop
    npx agent37 templates build . --name hermes-vnc-desktop --default-port 3737
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

import httpx
import pbt
from pbt.executor.run_context import parse_json_output as pbt_json

import agent_exec
from llm import model_name

MODEL_TYPE = "agent37"

# The config key naming the bullet's disk — its instance. The bullet's id.
DISK_KEY = "disk"
# The config key holding the bullet's own step limit. Absent means the run's.
STEPS_KEY = agent_exec.STEPS_KEY

API = os.environ.get("AGENT37_API_URL", "https://api.agent37.com/v1")
API_KEY_ENV = "AGENT37_API_KEY"
TEMPLATE = os.environ.get("AGENT37_TEMPLATE", "hermes-vnc-desktop")
# A cap on what one instance may spend on Agent37's managed services (web
# search, and the model when AGENT37_MANAGED_MODEL is set). Compute is billed
# apart from it, by the minute, while the instance runs.
BUDGET_MICROS = int(os.environ.get("AGENT37_BUDGET_MICROS", "1000000"))
# Run on Agent37's managed model, billed to the workspace, instead of the run's
# own provider and key.
MANAGED_MODEL = os.environ.get("AGENT37_MANAGED_MODEL", "").lower() in ("1", "true", "yes")
# Every kept instance's name starts with this, then the bullet's disk id.
NAME_PREFIX = "pbt-disk-"

# The longest a turn may run before it is cancelled and the bullet fails.
TIMEOUT_SECONDS = agent_exec.TIMEOUT_SECONDS
# How long a bullet waits for a free instance when the workspace is at its
# instance limit.
QUEUE_SECONDS = int(os.environ.get("AGENT37_QUEUE_SECONDS", "900"))
# How long an instance's agent may take to report healthy once it is running.
READY_SECONDS = int(os.environ.get("AGENT_READY_SECONDS", "240"))
# How long a stopped instance may take to be running again. Usually seconds,
# but Agent37 moves it to another host when its own is full, which takes
# minutes per 10 GB of disk.
START_SECONDS = int(os.environ.get("AGENT37_START_SECONDS", "900"))

# The noVNC port of the desktop template, and how long its link opens it for.
# The token in it grants full control and cannot be revoked, so it is short.
DESKTOP_PORT = 6901
DESKTOP_TTL_SECONDS = int(os.environ.get("AGENT37_DESKTOP_TTL_SECONDS", "300"))

MAX_OUTPUT_CHARS = agent_exec.MAX_OUTPUT_CHARS
MAX_LOG_LINES = agent_exec.MAX_LOG_LINES
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

This machine is yours across runs: what you leave on disk is there the next
time you are given a task, so check your home directory for earlier work.

You have about {steps} steps; leave the last of them for the answer rather
than running out mid-task.
Your final message is what the person reads, so make it the answer itself —
not a description of what you did or where you put it.
"""


def config_line(disk: str, steps: int = 0) -> str:
    """The bullet's config line, naming its disk and, when set, its step limit."""
    args = ['model_type="%s"' % MODEL_TYPE, "%s=%s" % (DISK_KEY, json.dumps(disk))]
    if steps and steps > 0:
        args.append("%s=%d" % (STEPS_KEY, int(steps)))
    return "{{ config(%s) }}" % ", ".join(args)


def enabled() -> bool:
    """Whether an Agent37 key is configured. Instances cost money, so the key
    is the server's alone — nothing is read from the browser."""
    return bool(os.environ.get(API_KEY_ENV))


@dataclass(frozen=True)
class _Provider:
    """The run's model, as Hermes' custom provider: endpoint, key, model id."""

    base_url: str
    api_key: str
    model: str
    # Also written to ~/.hermes/.env under this name — see `_HERMES_KEY_ENV`.
    key_env: str | None = None


def _provider(provider: str, api_key: str | None, model: str | None) -> _Provider | None:
    """The run's provider and key for Hermes, or None for Agent37's managed model."""
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
    """A failed agent run, with the log up to where it stopped."""

    def __init__(self, message: str, log: _Log) -> None:
        super().__init__(f"{message}\n\nLog (last lines):\n{log.tail()}")


def _raise_for(r: httpx.Response) -> None:
    if r.status_code < 400:
        return
    try:
        err = r.json().get("error") or {}
        detail = f"{err.get('code', '')}: {err.get('message', '')}".strip(": ")
    except ValueError:
        detail = r.text[:500]
    raise RuntimeError(f"Agent37 {r.request.method} {r.request.url.path} → {r.status_code} {detail}")


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

    def status(self) -> str:
        return self._api("GET", "").get("status", "")

    def exec(self, command: str) -> dict:
        return self._api("POST", "/exec", json={"command": command}, timeout=800)

    def start(self, log: _Log) -> None:
        """Bring a stopped or sleeping instance up, retrying while its sleep
        checkpoint is still being written, and wait until it reads running."""
        log.add("agent37", f"starting instance {self.id}")
        t0 = time.time()
        deadline = t0 + START_SECONDS
        while True:
            r = self.client.post(
                f"{API}/instances/{self.id}/start",
                headers={"Authorization": f"Bearer {self.key}"}, timeout=600,
            )
            if r.status_code == 409 and "try_again" in r.text and time.time() < deadline:
                time.sleep(5)
                continue
            _raise_for(r)
            break
        said = 0.0
        while (s := self.status()) != "running":
            if time.time() > deadline:
                raise AgentError(f"instance {self.id} was still '{s}' after {START_SECONDS}s", log)
            # A line every 30s, so a slow start does not look like a hang.
            if time.time() - said >= 30:
                log.add("agent37", f"instance {self.id} is '{s}' ({time.time() - t0:.0f}s so far)")
                said = time.time()
            time.sleep(3)
        log.add("agent37", f"instance {self.id} running after {time.time() - t0:.0f}s")

    def stop(self) -> None:
        deadline = time.time() + 120
        while True:
            r = self.client.post(
                f"{API}/instances/{self.id}/stop",
                headers={"Authorization": f"Bearer {self.key}"}, timeout=120,
            )
            if r.status_code == 409 and "try_again" in r.text and time.time() < deadline:
                time.sleep(5)
                continue
            _raise_for(r)
            return

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


def _name(disk: str) -> str:
    return NAME_PREFIX + re.sub(r"[^A-Za-z0-9_-]", "-", disk)[:60]


def _find(client: httpx.Client, key: str, name: str) -> dict | None:
    """The workspace's instance with *name*, if there is one."""
    r = client.get(f"{API}/instances", headers={"Authorization": f"Bearer {key}"}, timeout=60)
    _raise_for(r)
    for inst in r.json().get("data", []):
        if inst.get("name") == name and inst.get("status") not in ("deleted", "deleting"):
            return inst
    return None


def _create(client: httpx.Client, key: str, name: str, log: _Log) -> dict:
    """Create the instance, waiting for a free slot while the workspace is at
    its instance limit."""
    deadline = time.time() + QUEUE_SECONDS
    waiting = False
    while True:
        r = client.post(
            f"{API}/instances",
            headers={"Authorization": f"Bearer {key}"},
            json={"template": TEMPLATE, "name": name, "budget": {"credit_micros": BUDGET_MICROS}},
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


def _configure(inst: _Instance, steps: int, provider: _Provider | None, log: _Log) -> None:
    """Set the model and step limit with Hermes' own `config set`.

    Done every run, not only the first: the run's provider, key and steps can
    change between runs while the disk stays.
    """
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
    setup = " && ".join(f"hermes config set {k} {shlex.quote(v)}" for k, v in sets)
    if provider and provider.key_env:
        # Replaced rather than appended, so a kept disk does not pile up keys.
        env_line = shlex.quote(f"{provider.key_env}={provider.api_key}")
        setup += (
            f" && f=\"$(hermes config env-path)\" && touch \"$f\""
            f" && sed -i '/^{provider.key_env}=/d' \"$f\" && printf '%s\\n' {env_line} >> \"$f\""
        )
    out = inst.exec(setup + " < /dev/null")
    if out.get("exit_code") != 0:
        said = (out.get("stderr") or out.get("stdout") or "").strip()[-2000:]
        if provider:
            said = said.replace(provider.api_key, "<key>")
        raise AgentError(f"Configuring the agent failed: {said}", log)
    if provider:
        log.add("agent37", f"model: {provider.model} at {provider.base_url}")


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


def _answer(text: str, json_answer: bool, log: _Log) -> Any:
    text = text.strip()
    if not text:
        raise AgentError("The agent finished without an answer.", log)
    if not json_answer:
        return text[:MAX_OUTPUT_CHARS]
    try:
        return pbt_json(text)
    except ValueError as exc:
        raise AgentError(f"The agent's answer is not valid JSON: {exc}", log) from exc


def _run_instance(
    task: str,
    disk: str,
    provider: _Provider | None,
    steps: int,
    json_answer: bool,
    on_line: Callable[[str], None] | None = None,
) -> dict:
    """Run the agent on *task* on the bullet's kept instance. Blocking — call it off the loop."""
    key = os.environ[API_KEY_ENV]
    log = _Log(on_line)
    name = _name(disk)
    with httpx.Client(timeout=60) as client:
        found = _find(client, key, name)
        if found:
            inst = _Instance(client, key, found)
            log.add("agent37", f"reusing instance {inst.id} ({found.get('status')}), disk kept")
            if found.get("status") != "running":
                inst.start(log)
        else:
            log.add("agent37", f"no instance for this bullet yet; creating {name} (template {TEMPLATE})")
            inst = _Instance(client, key, _create(client, key, name, log))
        try:
            log.add("agent37", f"instance {inst.id} up; waiting for the agent")
            inst.wait_healthy(READY_SECONDS)
            try:
                log.add("desktop", f"watch the agent's screen: {_desktop_url(inst)}")
            except Exception as exc:  # noqa: BLE001 — the run does not need the view
                log.add("desktop", f"no desktop link: {exc}")
            _configure(inst, steps, provider, log)

            log.add("agent", f"starting (up to {steps} steps), task of {len(task)} chars")
            done = _stream_turn(inst, task + FINISHING.format(steps=steps), log)
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
        finally:
            try:
                inst.stop()
                log.add("agent37", f"instance {inst.id} stopped; its disk is kept for the next run")
            except Exception as exc:  # noqa: BLE001
                log.add("agent37", f"could not stop instance {inst.id}: {exc}")

    return {"output": answer, "logs": log.lines(), "run_time": round(time.time() - log.t0, 1)}


async def _run(
    task: str,
    disk: str,
    provider: _Provider | None,
    steps: int,
    json_answer: bool,
    on_line: Callable[[str], None] | None = None,
) -> dict:
    if not enabled():
        raise RuntimeError(
            f"Preserving an agent's disk needs Agent37, which is not configured on this server. Set {API_KEY_ENV}."
        )
    if not task.strip():
        raise RuntimeError("An agent bullet needs a task — its text, or something from below it.")
    return await asyncio.to_thread(_run_instance, task, disk, provider, steps, json_answer, on_line)


@pbt.model_kind(MODEL_TYPE, config_keys={DISK_KEY, STEPS_KEY})
async def execute(rendered: str, call: pbt.ModelCall) -> dict:
    """Hand the rendered bullet to the Hermes agent on the bullet's kept instance.

    Returns ``{"output", "logs", "run_time"}``, like `agent_exec.execute`.
    """
    disk = str(call.spec.config.get(DISK_KEY) or call.spec.name)
    run = agent_exec._settings.get()
    try:
        own = int(call.spec.config.get(STEPS_KEY) or 0)
    except (TypeError, ValueError):
        own = 0
    steps = agent_exec.steps_for(own) if own > 0 else run.steps
    provider = _provider(run.provider, run.api_key, run.model)
    name = call.spec.name
    on_line = (lambda line: run.on_log(name, line)) if run.on_log else None
    json_answer = call.spec.output_format == "json"
    raw = await call.compute(
        rendered,
        compute=lambda: _run(rendered.strip(), disk, provider, steps, json_answer, on_line),
    )
    return raw if isinstance(raw, dict) else json.loads(raw)
