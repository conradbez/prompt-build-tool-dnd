"""
A ``python`` bullet type: run the bullet's code in a Modal Sandbox.

``template`` needs no model type of its own — pbt ships one. Python cannot be
had that cheaply: the code has to run somewhere that is not this process, and
pbt's built-in ``execute_python`` runs it in-process. So this registers a model
type of its own.

A python bullet holds no code a person typed. It runs what its one child
produced — an LLM writes a script, the bullet above it executes that script —
so the only thing that ever reaches the sandbox came from upstream.

pbt exposes a public model-kind registry, so this is a plain
``pbt.ModelKind`` registered under ``python_modal``. The executor owns
rendering, the prompt cache, JSON parsing and storage; the exec function below
only supplies the interesting middle — hand the upstream output to a sandbox
and return what it printed.

Auth is Modal's usual environment: ``MODAL_TOKEN_ID`` / ``MODAL_TOKEN_SECRET``
(or a ``modal token new`` profile on the box). Nothing is read from the browser
— sandboxes cost money, so the key stays server-side.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import pbt

MODEL_TYPE = "python_modal"

# The bullet is prepended with this, exactly as template bullets get their own
# config line. See `main.py:_build_source`.
CONFIG_LINE = '{{ config(model_type="%s") }}' % MODEL_TYPE

APP_NAME = os.environ.get("MODAL_APP_NAME", "mindmap-python")

# Always present in the sandbox, so the common case pays no image build.
BASE_PACKAGES = ["numpy", "pandas", "requests"]

# There is deliberately no way to add to that list. A python bullet runs code
# written upstream — by an LLM, most of the time — so a package name would be
# chosen upstream too, and install-time code runs before the script does. The
# image is fixed here, where a person can see it.

TIMEOUT_SECONDS = int(os.environ.get("MODAL_TIMEOUT_SECONDS", "60"))
CPU = 1
MEMORY_MB = 2048

# Sandbox output is a bullet's result and travels back to the browser; cap it.
MAX_OUTPUT_CHARS = 10_000

_app = None
_base_image = None


def enabled() -> bool:
    """Whether Modal credentials are present. The UI hides `python` if not."""
    if os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET"):
        return True
    # A `modal token new` profile on the machine works just as well.
    return os.path.exists(os.path.expanduser("~/.modal.toml"))


def _lookup():
    """The Modal app and base image, created once and reused.

    Deferred rather than done at import: both calls hit the network, and a
    server with no Modal credentials must still start and serve prompt bullets.
    """
    global _app, _base_image
    if _app is None:
        import modal

        _app = modal.App.lookup(APP_NAME, create_if_missing=True)
        _base_image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
            *BASE_PACKAGES
        )
    return _app, _base_image


_FENCE = re.compile(r"```[a-zA-Z]*\n(.*?)```", re.DOTALL)


def _unfence(text: str) -> str:
    """The runnable code inside *text*: the first fenced block, or all of it.

    An empty python bullet runs its inputs, and those inputs usually come from
    an LLM that was asked for a script — which fences it, and often wraps it in
    "Here is a simple script…" and a How-to-run section, "no commentary" or
    not. Neither prose nor a fence is valid Python, so when there is a fenced
    block, that block is the program. The *first* one, not all of them: a
    chatty answer tends to follow the real script with variations on it.
    """
    m = _FENCE.search(text)
    return m.group(1) if m else text


def _inherited_code(inputs: list[Any]) -> str:
    """The program: whatever this bullet's child produced.

    A python bullet never carries code of its own. It is an operator — one
    child writes a script, the python bullet above it runs that script — so
    there is no text of its own to prefer, and nothing a person typed on the
    bullet can reach the sandbox. `main.py` holds it to a single input, so the
    join below is over a list of one; it is written this way so a graph that
    somehow arrives with more still runs rather than picking one at random.
    """
    return "\n".join(_unfence(str(i)) for i in inputs if str(i).strip())


def _program(inputs: list[Any], code: str) -> str:
    """The full program to run in the sandbox: the inputs, then the code.

    The sandbox is a different machine, so `ref()` cannot reach back into this
    process's `model_outputs` the way pbt's in-process handler does. The
    outputs are serialised into the source instead — through `json.dumps`
    twice, so each payload arrives as a Python string literal that no quote or
    newline in an LLM's answer can break out of.

    The bullet's own code is passed the same way and `compile`d rather than
    pasted in below the header, so a traceback reports the line the person
    wrote — line 1 of the bullet is line 1 in the error.
    """
    return (
        "import json as _json\n"
        f"inputs = _json.loads({json.dumps(json.dumps(inputs))})\n"
        "def ref(i=0):\n"
        "    return inputs[i]\n"
        f"exec(compile(_json.loads({json.dumps(json.dumps(code))}), "
        '"<bullet>", "exec"), globals())\n'
    )


def _run_sandbox(code: str) -> str:
    """Execute *code* in a fresh sandbox. Blocking — call it off the loop."""
    import modal

    app, base_image = _lookup()

    sb = modal.Sandbox.create(
        image=base_image,
        app=app,
        timeout=TIMEOUT_SECONDS,
        cpu=CPU,
        memory=MEMORY_MB,
    )
    try:
        p = sb.exec("python", "-c", code)
        out = p.stdout.read()
        err = p.stderr.read()
        returncode = p.wait()
    finally:
        sb.terminate()

    if returncode:
        # A traceback is the useful part of a failed run, so put it in the
        # error rather than returning a bullet result that looks like success.
        detail = (err or out or "").strip()[-MAX_OUTPUT_CHARS:]
        raise RuntimeError(f"Python bullet exited {returncode}:\n{detail}")

    result = (out or "").strip()
    if not result and err:
        result = err.strip()
    return result[:MAX_OUTPUT_CHARS]


async def _run(inputs: list[Any]) -> str:
    if not enabled():
        raise RuntimeError(
            "Python bullets run on Modal, which is not configured on this "
            "server. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET."
        )

    source = _inherited_code(inputs)
    if not source.strip():
        raise RuntimeError(
            "A python bullet runs the code its child produces, and this "
            "one received nothing to run. Give it a child that outputs a "
            "script."
        )

    # Modal's client is blocking, and pbt runs independent branches
    # concurrently — keep one sandbox from stalling the others.
    return await asyncio.to_thread(_run_sandbox, _program(inputs, source))


# Registered on import: the decorator runs when this module body executes, so
# importing `modal_exec` is what teaches pbt the kind. The rendered template is
# Python source, so prose prepended to it would not compile — hence
# `accepts_global_instruction=False`.
@pbt.model_kind(MODEL_TYPE, accepts_global_instruction=False)
async def execute(rendered: str, call: pbt.ModelCall) -> str:
    """Run the code this bullet's child produced, in a Modal Sandbox (gVisor).

    The bullet carries no code of its own — it is an operator, not an editor.
    Its child's output is the program, and is also readable by that program as
    ``inputs`` (a list, or ``ref(0)``). Whatever it prints is the bullet's
    output, which flows on downstream.
    """
    inputs = [call.outputs.get(dep) for dep in call.spec.depends_on]

    # A python bullet's own source renders to nothing (its refs live in a
    # Jinja comment — see `main.py:_python_source`), so the upstream outputs
    # *are* the program and have to be in the cache key. They are appended to
    # the text handed to `call.compute`, which is only ever used to build that
    # key; the prompt shown in the run report was recorded when the executor
    # rendered.
    cache_text = rendered + "\x00" + json.dumps(inputs, sort_keys=True, default=str)

    return await call.compute(cache_text, compute=lambda: _run(inputs))
