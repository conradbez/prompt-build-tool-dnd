"""The agent loop inside an agent bullet's sandbox: mini-swe-agent, bash as its only tool.

Usage: run_agent.py <task file> <result file>

The task arrives as a file rather than an argument because it is a rendered
bullet — upstream answers and all — and has no business being limited by argv.
The result is written as JSON to *result file*: the agent's own logging goes to
stdout, so stdout is no place to fish the answer out of.

Model and key come from the environment (`AGENT_MODEL`, and the provider's own
key variable, which litellm reads) — set by `agent_exec.py` per run.
"""
import json
import os
import sys

import yaml
from minisweagent.agents.default import DefaultAgent
from minisweagent.config import builtin_config_dir
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models import get_model
from minisweagent.models.utils.openai_multimodal import DEFAULT_MULTIMODAL_REGEX

ANSWER = "/root/answer.md"

MCP_TOOLS = """\
## MCP tools

An MCP tool server is available through the `mcp-call` command. Its session
persists between commands, so state carries over from one call to the next.

- `mcp-call list`                    list tools
- `mcp-call describe <tool>`         show a tool's description and JSON schema
- `mcp-call <tool> '<json args>'`    call a tool (single-quote the JSON)

Start with `mcp-call list`, and `describe` a tool before calling it.
Images returned by tools are shown to you directly (and saved to /tmp/mcp_out/).
Each one costs tokens for the rest of the run, so only ask for renders or
screenshots at key steps.
"""

# mini.yaml's own template runs the output through `tojson`, which escapes `<`
# and `>` and so breaks the multimodal tags, and it trims anything over 10k
# characters, which would cut an image's base64 in half. So: images pass
# through untouched, and other long output is trimmed to head and tail.
OBSERVATION_TEMPLATE = """<returncode>{{ output.returncode }}</returncode>
{% if output.exception_info %}<exception>{{ output.exception_info }}</exception>
{% endif -%}
{%- if 'MSWEA_MULTIMODAL_CONTENT' in output.output or output.output | length < 10000 -%}
<output>
{{ output.output }}</output>
{%- else -%}
<output_head>
{{ output.output[:5000] }}</output_head>
<elided_chars>{{ output.output | length - 10000 }}</elided_chars>
<output_tail>
{{ output.output[-5000:] }}</output_tail>
{%- endif -%}"""

# Our own, rather than mini.yaml's: that one is written for fixing an issue in a
# repository, and its finishing rule ("do not combine it with any other
# command") would throw away the answer, which is the whole point here.
INSTANCE_TEMPLATE = """\
{{task}}

## How to work

You work in a Linux sandbox through a bash tool. Every command runs in a fresh
subshell, so `cd` and environment variables do not persist — prefix them to the
command that needs them, or write them to a file. Your working directory is
/root. Python 3.12, `uv`/`uvx`, Node (`npx`), git and curl are installed.

{{mcp_tools}}
## Finishing

Your final answer is what the person reads, so make it the answer itself — not
a description of what you did. When you have it:

1. Write it to """ + ANSWER + """.
2. Run exactly: `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat """ + ANSWER + """`

After that command you cannot continue.

<system_information>
{{system}} {{release}} {{version}} {{machine}}
</system_information>
"""


def main(task_path: str, result_path: str) -> None:
    with open(task_path) as f:
        task = f.read()

    config = yaml.safe_load((builtin_config_dir / "mini.yaml").read_text())
    agent_config = {
        k: v for k, v in config.get("agent", {}).items() if k in ("system_template",)
    }
    agent_config.update(
        instance_template=INSTANCE_TEMPLATE,
        step_limit=int(os.environ.get("AGENT_STEP_LIMIT", "30")),
        cost_limit=float(os.environ.get("AGENT_COST_LIMIT", "1.0")),
        wall_time_limit_seconds=int(os.environ.get("AGENT_WALL_SECONDS", "0")),
    )

    model = get_model(
        os.environ["AGENT_MODEL"],
        config.get("model", {})
        | {
            "observation_template": OBSERVATION_TEMPLATE,
            "multimodal_regex": DEFAULT_MULTIMODAL_REGEX,
            # A model litellm cannot price would otherwise stop the run. The
            # cost limit then cannot bite, which is what the step limit is for.
            "cost_tracking": "ignore_errors",
        },
    )
    # 300s a command, not the default 30: MCP tool calls (renders, exports) are slow.
    env = LocalEnvironment(
        **{**config.get("environment", {}), "cwd": "/root", "timeout": 300}
    )
    agent = DefaultAgent(model, env, **agent_config)

    has_mcp = os.path.exists(os.environ.get("MCP_SOCK", "/tmp/mcp.sock"))
    result: dict = {}
    try:
        info = agent.run(task, mcp_tools=MCP_TOOLS if has_mcp else "")
        result = {
            "exit_status": info.get("exit_status", ""),
            "submission": info.get("submission", ""),
        }
    except Exception as e:  # noqa: BLE001 — reported back, not swallowed
        result = {"exit_status": type(e).__name__, "submission": "", "error": str(e)}

    # The last thing the model said, for a run that stopped without answering:
    # "LimitsExceeded" alone does not tell anyone what it was stuck on.
    said = [m for m in agent.messages if m.get("role") == "assistant"]
    last = said[-1].get("content") if said else ""
    result.update(
        steps=agent.n_calls,
        cost=agent.cost,
        last_message=last if isinstance(last, str) else json.dumps(last)[:4000],
    )
    with open(result_path, "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
