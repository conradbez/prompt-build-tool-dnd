"""Start an Agent37 desktop instance, print its VNC link, and give the agent one task.

    python server/agent37_try.py "run python hello world on fastapi server"

Uses `agent_exec`'s client and the Gemini key from the repo's `.env`. The
instance is kept for KEEP_SECONDS after the agent answers, so the desktop can
still be looked at, then deleted. Ctrl+C deletes it at once.
"""

import os
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

import agent_exec  # noqa: E402

KEEP_SECONDS = int(os.environ.get("KEEP_SECONDS", "600"))


def main(task: str) -> None:
    key = os.environ[agent_exec.API_KEY_ENV]
    provider = agent_exec._provider("gemini", os.environ["GEMINI_API_KEY"], None)
    log = agent_exec._Log(lambda line: print(line, flush=True))
    with httpx.Client(timeout=60) as client:
        log.add("agent37", f"creating instance (template {agent_exec.TEMPLATE})")
        inst = agent_exec._Instance(client, key, agent_exec._create(client, key, log))
        try:
            inst.wait_healthy(agent_exec.READY_SECONDS)
            print(f"\nVNC: {agent_exec._desktop_url(inst)}\n", flush=True)
            agent_exec._configure(inst, agent_exec.STEP_LIMIT, "", False, provider, log)
            done = agent_exec._stream_turn(inst, agent_exec._task(task, agent_exec.STEP_LIMIT, False, False), log)
            print("\nANSWER:", done.get("output_text") or done.get("error"), flush=True)
            print(f"\nKeeping the instance for {KEEP_SECONDS}s; Ctrl+C to delete it now.", flush=True)
            time.sleep(KEEP_SECONDS)
        finally:
            inst.delete()
            print("instance deleted", flush=True)


if __name__ == "__main__":
    main(" ".join(sys.argv[1:]) or "run python hello world on fastapi server")
