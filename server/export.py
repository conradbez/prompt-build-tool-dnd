"""
Turn a bullet graph into a promptmap project you can run without this app.

Two shapes, both plain Python files:

* ``script``  — one file: the models as a dict, a small ``llm_call``, and
  ``promptmap.async_run``. Run it and it prints every bullet's answer, then
  judges the test bullets with promptmap's own tester.
* ``project`` — one file that *writes* a promptmap project: ``map/<name>.prompt``
  per bullet, ``map/<name>.testprompt`` per test bullet, plus a ``client.py`` —
  the layout ``promptmap serve`` / ``run`` / ``test`` expect.

Test bullets leave as promptmap *tests*, not models. In a project they are
gates, so ``promptmap run`` stops when one fails, which this app never does.

The sources come from `main._build_source`, the same function the runner uses,
so an export is the graph as it actually runs rather than a second rendering of
it that can drift. What differs is the naming: a run uses `n_<bullet id>`, which
is stable but unreadable, while an export names each model after its bullet's
title, because a person is going to open these files.
"""

from __future__ import annotations

import re
import textwrap
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover — import cycle at runtime, types only here
    from main import Node

# What a `.prompt` file may be called, and what `ref('…')` then has to say.
_UNSAFE = re.compile(r"[^a-z0-9]+")
_MAX_NAME = 40


def model_names(nodes: list["Node"]) -> dict[str, str]:
    """Bullet id → a readable, unique model name taken from its title."""
    out: dict[str, str] = {}
    used: set[str] = set()
    for i, node in enumerate(nodes, start=1):
        base = _slug(node.title) or f"bullet_{i}"
        name = base
        n = 2
        while name in used:
            name = f"{base}_{n}"
            n += 1
        used.add(name)
        out[node.id] = name
    return out


def _slug(text: str) -> str:
    """A title, as a Python-ish identifier. Empty when there is none."""
    line = text.split("\n", 1)[0] if text else ""
    line = re.sub(r"^\s*(#{1,6}\s+|[-*+]\s+|>\s+)", "", line)  # markdown marks
    slug = _UNSAFE.sub("_", line.lower()).strip("_")[:_MAX_NAME].strip("_")
    # A name has to start with a letter to be a legal identifier *and* to read
    # as a name rather than a version number.
    return slug if slug[:1].isalpha() else ""


def warnings(nodes: list["Node"]) -> list[str]:
    """What will not survive the trip out of this app, said plainly.

    An export that quietly drops something is worse than one that says what it
    could not take with it: the graph still runs, just not the same way.
    """
    out: list[str] = []
    if any(n.files for n in nodes):
        out.append(
            "Attachments stay behind: they live in this server's bucket, and the "
            "exported project has no way to fetch them. The `promptfiles` config "
            "line is kept, so pass the files yourself when you run it."
        )
    if any(n.kind == "python" for n in nodes):
        out.append(
            "Python bullets need the `python_modal` model kind from the "
            "`promptmap-extra-model-kinds` package, not promptmap. Install it alongside "
            "promptmap, or those bullets will fail as an unknown model type."
        )
    if any(n.kind == "agent" for n in nodes):
        out.append(
            "Agent bullets need the `agent_modal` model kind from the "
            "`promptmap-extra-model-kinds` package, not promptmap. Install it, and call "
            "`promptmap_extra_model_kinds.agent_exec.use_run` "
            "before running, or those bullets will fail."
        )
    return out


# --------------------------------------------------------------------------
# The generated files
# --------------------------------------------------------------------------

_ENV_KEY = {"gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "openrouter": "OPENROUTER_API_KEY"}


def _lit(text: str) -> str:
    """A triple-quoted literal that no prompt can break out of."""
    escaped = text.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
    # A prompt ending in a quote would otherwise close the literal with four.
    if escaped.endswith('"'):
        escaped += "\\n"
    return f'"""{escaped}"""'


def _header(lines: list[str]) -> str:
    """The `###` block at the top. Long lines are wrapped rather than left to
    run off the side of an editor — this is the part meant to be read first."""
    out: list[str] = []
    for line in lines:
        for piece in (textwrap.wrap(line, 74) if len(line) > 74 else [line]):
            out.append(f"### {piece}" if piece else "###")
    return "\n".join(out)


def _llm_call(provider: str) -> str:
    """A small `llm_call`, one provider deep — the same shape as `llm.py`.

    The template passthrough is not optional: promptmap parses `model_type` into
    `model.config` and otherwise runs a template node like any other prompt, so
    without this the node's text would be answered instead of passed on.
    """
    key_env = _ENV_KEY.get(provider, "GEMINI_API_KEY")
    calls = {
        "gemini": (
            "    from google import genai\n"
            "    from google.genai import types\n\n"
            "    client = genai.Client(api_key=KEY)\n"
            "    resp = client.models.generate_content(\n"
            '        model="gemini-3.6-flash",\n'
            "        contents=[prompt],\n"
            "        config=types.GenerateContentConfig(response_mime_type=\"application/json\")\n"
            "        if wants_json\n"
            "        else None,\n"
            "    )\n"
            '    return resp.text or ""'
        ),
        "openai": (
            "    import openai\n\n"
            "    client = openai.OpenAI(api_key=KEY)\n"
            "    resp = client.chat.completions.create(\n"
            '        model="gpt-4o-mini",\n'
            '        messages=[{"role": "user", "content": prompt}],\n'
            '        **({"response_format": {"type": "json_object"}} if wants_json else {}),\n'
            "    )\n"
            '    return resp.choices[0].message.content or ""'
        ),
        "anthropic": (
            "    import anthropic\n\n"
            "    client = anthropic.Anthropic(api_key=KEY)\n"
            "    msg = client.messages.create(\n"
            '        model="claude-sonnet-4-5",\n'
            "        max_tokens=4096,\n"
            '        messages=[{"role": "user", "content": prompt}],\n'
            "    )\n"
            '    return "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")'
        ),
        "openrouter": (
            "    import openai\n\n"
            '    client = openai.OpenAI(api_key=KEY, base_url="https://openrouter.ai/api/v1")\n'
            "    resp = client.chat.completions.create(\n"
            '        model="deepseek/deepseek-v4.1-flash",\n'
            '        messages=[{"role": "user", "content": prompt}],\n'
            '        **({"response_format": {"type": "json_object"}} if wants_json else {}),\n'
            "    )\n"
            '    return resp.choices[0].message.content or ""'
        ),
    }
    body = calls.get(provider, calls["gemini"])
    return (
        f'KEY = os.environ.get("{key_env}")\n\n\n'
        "def llm_call(prompt, files=None, config=None):\n"
        '    """One call to the model. `config` is this bullet\'s {{ config(...) }}."""\n'
        "    cfg = config or {}\n"
        '    if cfg.get("model_type") == "template":\n'
        "        # A template bullet is a passthrough: the rendered prompt *is*\n"
        "        # the output, so it is never sent anywhere.\n"
        "        return prompt.strip()\n"
        "    if not KEY:\n"
        f'        raise RuntimeError("Set {key_env} before running this.")\n'
        '    wants_json = cfg.get("output_format") == "json"\n\n'
        f"{body}\n\n\n"
        "def classify_call(state, question):\n"
        '    """P(yes) for a classifier-judged test. promptmap calls this, not llm_call.\n\n'
        '    Reads TYPESAFE_API_KEY / TYPESAFE_BASE_URL / TYPESAFE_DEFAULT_MODEL."""\n'
        "    import promptmap\n\n"
        "    return promptmap.systemone_classifier()(state, question)\n"
    )


def script(
    name: str,
    models: dict[str, str],
    tests: dict[str, str],
    provider: str,
    global_instruction: str,
    promptdata: dict[str, str],
    notes: list[str],
) -> str:
    """One runnable file: the whole pipeline, `promptmap.async_run` over it, then
    the tests through `promptmap.tester.execute_tests`. That is after the whole
    run rather than as gates, since `async_run` does not run tests."""
    head = _header(
        [
            f"{name} — exported from the mind map, as a promptmap pipeline.",
            "",
            "Run it:",
            "",
            "  pip install promptmap",
            f"  export {_ENV_KEY.get(provider, 'GEMINI_API_KEY')}=...",
            "  python " + filename(name, "script"),
            "",
            "Each bullet is one promptmap model. A bullet's children and its @ references",
            "became {{ ref('...') }} dependencies, so promptmap works out the order and runs",
            "independent branches in parallel — the graph is in MODELS, not in the",
            "order the dict happens to be written in.",
            *(
                [
                    "",
                    "Test bullets are promptmap tests (TESTS), judged once every model has",
                    "run. Each verdict is printed, and a failing test exits non-zero.",
                ]
                if tests
                else []
            ),
            *(["", *notes] if notes else []),
        ]
    )
    entries = "\n".join(f"    {n!r}: {_lit(src)},\n" for n, src in models.items())
    test_entries = "\n".join(f"    {n!r}: {_lit(src)},\n" for n, src in tests.items())
    return (
        f"{head}\n\n"
        "import asyncio\n"
        "import os\n"
        "import sys\n\n"
        "import promptmap\n"
        "from promptmap.storage.sqlite import SQLiteStorageBackend\n"
        "from promptmap.tester import execute_tests\n\n"
        "MODELS = {\n"
        f"{entries}"
        "}\n\n"
        "TESTS = {\n"
        f"{test_entries}"
        "}\n\n"
        f"PROMPTDATA = {promptdata!r}\n\n"
        f"GLOBAL_INSTRUCTION = {_lit(global_instruction) if global_instruction else 'None'}\n\n\n"
        f"{_llm_call(provider)}\n\n"
        "async def main():\n"
        "    store = SQLiteStorageBackend()\n"
        "    outputs = await promptmap.async_run(\n"
        "        models_from_dict=MODELS,\n"
        "        llm_call=llm_call,\n"
        "        promptdata=PROMPTDATA or None,\n"
        "        global_instruction=GLOBAL_INSTRUCTION,\n"
        "        wrap_refs=True,\n"
        "        storage_backend=store,\n"
        "    )\n"
        "    for model, value in outputs.items():\n"
        '        print(f"\\n=== {model} ===\\n{value}")\n'
        "    if not TESTS:\n"
        "        return 0\n"
        "    results = execute_tests(\n"
        '        run_id=store.get_latest_runs(1)[0]["run_id"],\n'
        "        tests=TESTS,\n"
        "        model_outputs=outputs,\n"
        "        storage_backend=store,\n"
        "        llm_call=llm_call,\n"
        "        classify_call=classify_call,\n"
        "        promptdata=PROMPTDATA or None,\n"
        "    )\n"
        '    print("\\n=== tests ===")\n'
        "    for r in results:\n"
        '        print(f"{r.status.upper():5}  {r.test_name}  {r.error or r.llm_output}")\n'
        '    return 0 if all(r.status == "pass" for r in results) else 1\n\n\n'
        'if __name__ == "__main__":\n'
        "    sys.exit(asyncio.run(main()))\n"
    )


def project(
    name: str,
    models: dict[str, str],
    tests: dict[str, str],
    provider: str,
    global_instruction: str,
    promptdata: dict[str, str],
    notes: list[str],
) -> str:
    """A file that writes the project `promptmap serve` expects, then gets out of the way.

    `promptmap serve` reads a directory of `.prompt` files and a `client.py` beside
    it, so the export cannot be the project — it has to be the thing that lays
    the project out. Running it twice is safe: it rewrites what it wrote.
    """
    head = _header(
        [
            f"{name} — exported from the mind map, as a promptmap project to serve.",
            "",
            "Run it:",
            "",
            "  pip install promptmap uvicorn",
            f"  export {_ENV_KEY.get(provider, 'GEMINI_API_KEY')}=...",
            "  python " + filename(name, "project") + "   # writes ./models and ./client.py",
            "  promptmap serve --map-dir map",
            "",
            "`promptmap serve` then answers POST /run with",
            '  {"promptdata": {...}, "select": ["model_name"]}',
            "and returns every model's output. `promptmap run` works on the same folder.",
            *(
                [
                    "",
                    "Test bullets are written as map/*.testprompt. `promptmap run` treats",
                    "each as a gate: it runs right after the models it reads, and a failing",
                    "one stops the run. `promptmap test` runs them on their own. Add",
                    "{{ config(gate=False) }} to a test to keep it out of `run`.",
                ]
                if tests
                else []
            ),
            "",
            "The prompts are ordinary files after this — edit them there, not here;",
            "this script overwrites them each time it runs.",
            *(["", *notes] if notes else []),
        ]
    )
    entries = "\n".join(f"    {n!r}: {_lit(src)},\n" for n, src in models.items())
    test_entries = "\n".join(f"    {n!r}: {_lit(src)},\n" for n, src in tests.items())
    global_block = (
        f"(ROOT / \"global.prompt\").write_text(GLOBAL_INSTRUCTION, encoding=\"utf-8\")\n"
        if global_instruction
        else "pass  # no global instruction was set\n"
    )
    return (
        f"{head}\n\n"
        "import os\n"
        "from pathlib import Path\n\n"
        "ROOT = Path(__file__).resolve().parent\n"
        'MODELS_DIR = ROOT / "map"\n\n'
        "MODELS = {\n"
        f"{entries}"
        "}\n\n"
        "TESTS = {\n"
        f"{test_entries}"
        "}\n\n"
        f"PROMPTDATA = {promptdata!r}  # promptmap run --promptdata key=value, or POST /run\n\n"
        f"GLOBAL_INSTRUCTION = {_lit(global_instruction) if global_instruction else '\"\"'}\n\n"
        f"CLIENT_PY = {_lit(_llm_call(provider))}\n\n\n"
        "def main():\n"
        "    MODELS_DIR.mkdir(exist_ok=True)\n"
        "    for model, source in MODELS.items():\n"
        '        (MODELS_DIR / f"{model}.prompt").write_text(source, encoding="utf-8")\n'
        "    for test, source in TESTS.items():\n"
        '        (MODELS_DIR / f"{test}.testprompt").write_text(source, encoding="utf-8")\n'
        '    (ROOT / "client.py").write_text("import os\\n\\n\\n" + CLIENT_PY, encoding="utf-8")\n'
        "    if GLOBAL_INSTRUCTION:\n"
        f"        {global_block}"
        '    print(f"Wrote {len(MODELS)} prompts and {len(TESTS)} tests to {MODELS_DIR}, and client.py.")\n'
        '    print("Now run:  promptmap serve --map-dir map")\n\n\n'
        'if __name__ == "__main__":\n'
        "    main()\n"
    )


def _filename(name: str, suffix: str) -> str:
    return (_slug(name) or "mindmap") + suffix


def filename(name: str, target: str) -> str:
    return _filename(name, "_serve.py" if target == "project" else "_pipeline.py")
