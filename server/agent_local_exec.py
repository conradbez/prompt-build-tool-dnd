"""
An ``agent_local`` bullet type: the agent loop runs here, every command runs on Modal.

The ``agent`` node (`agent_exec.py`) ships the whole loop into a sandbox. This
one keeps mini-swe-agent's loop — and so every model call — in this server
process, and gives it an environment whose ``execute`` sends each bash command
to a Modal sandbox and hands back what it printed:

    this server                               Modal sandbox (sleep infinity)
    ┌───────────────────────────────┐
    │ DefaultAgent                  │   sb.exec(bash -c <command>)
    │   LitellmModel ── the model   │ ─────────────────────────────▶  bash
    │   ModalEnvironment.execute ───┼ ◀─────────────────────────────  output, exit code
    └───────────────────────────────┘

What that buys over the ``agent`` node:

* The API key never enters the sandbox. It goes to litellm per call as a
  keyword argument, so nothing the agent runs can read it — and, not being
  written into the process environment either, concurrent runs keep their own.
* The loop's messages are here, in memory: no task file, no result file, and
  the log's timestamps are all on one clock.

What it gives up: MCP. There is no daemon, so no tools beyond bash. Each step
also pays a round trip to Modal, which is small next to the model call it
follows.

The sandbox uses the ``agent`` node's image (Python, uv, Node, git, curl), so a
script behaves the same in either. The output has the same shape too:
``{"output", "logs", "run_time"}``.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

# mini-swe-agent prints a banner on import unless told not to.
os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")

import pbt  # noqa: E402

import agent_exec  # noqa: E402
from agent_exec import _Log  # noqa: E402

MODEL_TYPE = "agent_local_modal"
CONFIG_LINE = '{{ config(model_type="%s") }}' % MODEL_TYPE

# Each command's own limit. 124 is what `timeout` exits with when it fires.
COMMAND_TIMEOUT = int(os.environ.get("AGENT_COMMAND_TIMEOUT", "300"))
_TIMED_OUT = 124


def _environment_class():
    """`ModalEnvironment`, built on first use.

    mini-swe-agent pulls in litellm, which takes seconds to import, so a server
    that never runs an agent never pays for it.
    """
    from minisweagent.environments.local import LocalEnvironment
    from minisweagent.utils.serialize import recursive_merge

    class ModalEnvironment(LocalEnvironment):
        """mini-swe-agent's local environment, with `execute` sent to a sandbox.

        Subclassed rather than written from scratch for `_check_finished`: the
        rule for recognising a submission stays mini-swe-agent's own.
        """

        def __init__(self, sb, uname: dict[str, str], **kwargs):
            super().__init__(**kwargs)
            self.sb = sb
            self.uname = uname

        def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict[str, Any]:
            command = action.get("command", "")
            limit = timeout or self.config.timeout
            try:
                # The command arrives as `$2`, never spliced into a shell string,
                # so no quote in it can escape. stderr joins stdout, as it does
                # locally, because the model reads them as one.
                p = self.sb.exec(
                    "timeout", str(limit),
                    "bash", "-c", 'cd "$1" && exec bash -c "$2" 2>&1',
                    "_", cwd or self.config.cwd, command,
                )
                out = p.stdout.read()
                code = p.wait()
                output = {
                    "output": out,
                    "returncode": code,
                    "exception_info": f"The command timed out after {limit}s." if code == _TIMED_OUT else "",
                }
            except Exception as e:  # noqa: BLE001 — the model is told, and carries on
                output = {
                    "output": "",
                    "returncode": -1,
                    "exception_info": f"An error occurred while executing the command: {e}",
                    "extra": {"exception_type": type(e).__name__, "exception": str(e)},
                }
            self._check_finished(output)
            return output

        def get_template_vars(self, **kwargs) -> dict[str, Any]:
            # The sandbox's machine, not this one — and none of this process's
            # environment, which `LocalEnvironment` would put in the prompt.
            return recursive_merge(self.config.model_dump(), self.uname, kwargs)

    return ModalEnvironment


def _uname(sb) -> dict[str, str]:
    """The sandbox's `uname`, for the prompt's system information."""
    p = sb.exec("sh", "-c", "uname -s; uname -r; uname -v; uname -m")
    lines = (p.stdout.read().splitlines() + ["", "", "", ""])[:4]
    p.wait()
    return dict(zip(("system", "release", "version", "machine"), lines))


def _run_local(task: str, provider: str, api_key: str, json_answer: bool) -> dict:
    """Run the loop here against a fresh sandbox. Blocking — call it off the loop."""
    import modal
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.models import get_model

    from agent import run_agent

    log = _Log()
    config = run_agent.mini_config()
    model_name = agent_exec.litellm_model(provider)
    app, image = agent_exec._lookup()

    log.add(
        "modal",
        f"creating sandbox (app {agent_exec.APP_NAME}, {agent_exec.CPU} cpu, "
        f"{agent_exec.MEMORY_MB} MB, timeout {agent_exec.TIMEOUT_SECONDS}s)",
    )
    sb = modal.Sandbox.create(
        "sleep", "infinity",
        app=app,
        image=image,
        timeout=agent_exec.TIMEOUT_SECONDS,
        workdir="/root",
        cpu=agent_exec.CPU,
        memory=agent_exec.MEMORY_MB,
        # mini.yaml's quiet-pager settings. Nothing secret goes in.
        secrets=[modal.Secret.from_dict(config.get("environment", {}).get("env", {}))],
    )
    log.add("modal", f"sandbox {sb.object_id} up")
    try:
        env = _environment_class()(
            sb, _uname(sb), cwd="/root", timeout=COMMAND_TIMEOUT
        )
        # The key rides on each litellm call, not in os.environ: two runs with
        # two keys can be in this process at once.
        model = get_model(model_name, run_agent.model_config(config, api_key=api_key))
        agent = DefaultAgent(
            model,
            env,
            **run_agent.agent_kwargs(config, agent_exec.STEP_LIMIT, agent_exec.COST_LIMIT),
        )
        log.add(
            "agent",
            f"starting here, commands on Modal ({model_name}, up to "
            f"{agent_exec.STEP_LIMIT} steps), task of {len(task)} chars",
        )
        result = run_agent.run(agent, task, mcp_tools="")
        for e in result["events"]:
            log.add(e["source"], e["message"], e["ts"])
        log.add(
            "agent",
            f"finished: {result.get('exit_status') or 'unknown'} after {result.get('steps', '?')} steps"
            + (f", ${result['cost']:.4f}" if result.get("cost") else ""),
        )
    finally:
        sb.terminate()
        log.add("modal", "sandbox terminated")

    return {
        "output": agent_exec._answer(result, json_answer, log),
        "logs": log.lines(),
        "run_time": round(time.time() - log.t0, 1),
    }


async def _run(task: str, provider: str, api_key: str, json_answer: bool) -> str:
    if not agent_exec.enabled():
        raise RuntimeError(
            "Agent bullets run their commands on Modal, which is not configured "
            "on this server. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET."
        )
    if refused := agent_exec.rejected():
        raise RuntimeError(
            f"{agent_exec.APT_ENV} / {agent_exec.PIP_ENV} list something that is "
            f"not a package name: {', '.join(refused)}."
        )
    if not task.strip():
        raise RuntimeError("An agent bullet needs a task — its text, or something from below it.")
    # The loop is synchronous — litellm and Modal's client both block — and
    # pbt runs independent branches concurrently, so it gets a thread.
    result = await asyncio.to_thread(_run_local, task, provider, api_key, json_answer)
    # Text for `call.compute` to cache, parsed back in `execute`.
    return json.dumps(result, ensure_ascii=False)


@pbt.model_kind(MODEL_TYPE)
async def execute(rendered: str, call: pbt.ModelCall) -> dict:
    """Run a coding agent on the rendered bullet: loop here, commands on Modal.

    Returns ``{"output", "logs", "run_time"}``, like the ``agent`` node.
    """
    provider, sent_key = agent_exec.current_provider()
    api_key = agent_exec.api_key_for(provider, sent_key)
    json_answer = call.spec.output_format == "json"

    # The model is invisible in `rendered`, and the same task given to another
    # model is a different run.
    cache_text = "\x00".join([rendered, agent_exec.litellm_model(provider), str(json_answer)])
    raw = await call.compute(
        cache_text, compute=lambda: _run(rendered.strip(), provider, api_key, json_answer)
    )
    return json.loads(raw)
