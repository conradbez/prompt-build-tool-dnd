"""
Turn a bullet graph into a promptmap project you can run without this app.

Two shapes, both plain Python files:

* ``script``  — one file: the models as a dict and ``promptmap.async_run`` over
  them, on promptmap's own LiteLLM backend. Run it and it prints every
  bullet's answer, then judges the test bullets with promptmap's own tester.
* ``project`` — one file that *writes* a promptmap project: the models and tests
  as a promptmap construct (``map/<name>.prompt``, ``map/<name>.testprompt``,
  ``promptdata.yml``), plus ``settings.yml`` naming the provider and model —
  the layout ``promptmap run`` / ``test`` / ``serve`` expect.

No LLM client is generated: promptmap's default backend (LiteLLM, reading the
provider and model from ``settings.yml`` and the key from the environment)
runs the exported prompts, and honours a bullet's own ``config(model=…)``
exactly as this app does. A ``client.py`` is written only when a test is
judged by the classifier, for its ``classify_call``.

Test bullets leave as promptmap *tests*, not models. In a project they are
gates, so ``promptmap run`` stops when one fails, which this app never does.

The sources come from `main._build_source`, the same function the runner uses,
and both name each model after its bullet's title (`model_names`), so an export
is the graph as it actually runs rather than a second rendering that can drift.
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


def warnings(nodes: list["Node"], provider: str = "gemini") -> list[str]:
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
    if any(n.kind == "agent" for n in nodes):
        out.append(
            "Agent bullets need the `agent_modal` model kind from the "
            "`promptmap-extra-model-kinds` package, not promptmap. Install it, and call "
            "`promptmap_extra_model_kinds.agent_exec.use_run` "
            "before running, or those bullets will fail."
        )
    if any(n.kind == "search" for n in nodes):
        if provider in _ENV_KEY and provider != "openrouter":
            out.append(
                f"Search bullets call `rag_{provider}_search` from promptmap-extra-model-kinds "
                f'(pip install "promptmap[extras]"), on {_ENV_KEY[provider]}.'
            )
        else:
            out.append(
                "Search bullets call `rag_brave_search` from promptmap-extra-model-kinds "
                '(pip install "promptmap[extras]"): set BRAVE_API_KEY before running.'
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


def _classifier_tests(tests: dict[str, str]) -> bool:
    return any('judge="classifier"' in src for src in tests.values())


#: The client.py a project needs only for classifier-judged tests: promptmap
#: reads `classify_call` from it, and still runs the models on settings.yml.
CLASSIFY_CLIENT = (
    "import promptmap\n\n\n"
    "def classify_call(state, question):\n"
    '    """P(yes) for a classifier-judged test.\n\n'
    '    Reads TYPESAFE_API_KEY / TYPESAFE_BASE_URL / TYPESAFE_DEFAULT_MODEL."""\n'
    "    return promptmap.systemone_classifier()(state, question)\n"
)


def _searches(models: dict[str, str]) -> bool:
    return any(re.search(r"\brag_\w+_search\(", src) for src in models.values())


def _install(models: dict[str, str]) -> str:
    """The pip line: extras when a model needs a kind or search from them."""
    extras = _searches(models) or any(
        f'model_type="{kind}"' in src
        for src in models.values()
        for kind in ("agent_modal", "agent37")
    )
    return "  pip install " + ('"promptmap[extras]"' if extras else "promptmap")


def _key_line(provider: str, models: dict[str, str]) -> list[str]:
    lines = [f"  export {_ENV_KEY.get(provider, 'GEMINI_API_KEY')}=..."]
    if any("rag_brave_search(" in src for src in models.values()):
        lines.append("  export BRAVE_API_KEY=...   # for the search bullets")
    return lines


def settings_yml(provider: str, model: str) -> str:
    """promptmap's settings.yml: the provider and model its LiteLLM backend calls."""
    return f"provider: {provider}\nmodel: {model}\n"


def script(
    name: str,
    models: dict[str, str],
    tests: dict[str, str],
    provider: str,
    model: str,
    global_instruction: str,
    promptdata: dict[str, str],
    notes: list[str],
) -> str:
    """One runnable file: the whole pipeline, `promptmap.async_run` over it, then
    the tests through `promptmap.tester.execute_tests`. That is after the whole
    run rather than as gates, since `async_run` does not run tests."""
    classifier = _classifier_tests(tests)
    head = _header(
        [
            f"{name} — exported from the mind map, as a promptmap pipeline.",
            "",
            "Run it:",
            "",
            _install(models),
            *_key_line(provider, models),
            "  python " + filename(name, "script"),
            "",
            "Each bullet is one promptmap model. A bullet's children and its @ references",
            "became {{ ref('...') }} dependencies, so promptmap works out the order and runs",
            "independent branches in parallel — the graph is in MODELS, not in the",
            "order the dict happens to be written in.",
            "",
            f"Models run on {provider}/{model} through promptmap's LiteLLM backend;",
            "change PROVIDER / MODEL below, or a bullet's own config(model=...).",
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
        "import sys\n\n"
        "import promptmap\n"
        "from promptmap.llm import litellm_llm_call\n"
        "from promptmap.storage.sqlite import SQLiteStorageBackend\n"
        "from promptmap.tester import execute_tests\n\n"
        f"PROVIDER = {provider!r}\n"
        f"MODEL = {model!r}\n\n"
        "MODELS = {\n"
        f"{entries}"
        "}\n\n"
        "TESTS = {\n"
        f"{test_entries}"
        "}\n\n"
        f"PROMPTDATA = {promptdata!r}\n\n"
        f"GLOBAL_INSTRUCTION = {_lit(global_instruction) if global_instruction else 'None'}\n\n\n"
        "async def main():\n"
        "    llm_call = litellm_llm_call(PROVIDER, MODEL)  # key from the environment\n"
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
        + (
            "        classify_call=promptmap.systemone_classifier(),  # TYPESAFE_API_KEY\n"
            if classifier
            else ""
        )
        + "        promptdata=PROMPTDATA or None,\n"
        "    )\n"
        '    print("\\n=== tests ===")\n'
        "    for r in results:\n"
        '        print(f"{r.status.upper():5}  {r.test_name}  {r.error or r.llm_output}")\n'
        '    return 0 if all(r.status == "pass" for r in results) else 1\n\n\n'
        'if __name__ == "__main__":\n'
        "    sys.exit(asyncio.run(main()))\n"
    )


def construct_json(models: dict[str, str], tests: dict[str, str], promptdata: dict[str, str]) -> str:
    """The project as promptmap's construct JSON (`promptmap.export_to_json`)."""
    import promptmap

    construct = promptmap.import_from_json(
        {"models": models, "tests": tests, "promptdata": promptdata}
    )
    return promptmap.export_to_json(construct)


def project(
    name: str,
    models: dict[str, str],
    tests: dict[str, str],
    provider: str,
    model: str,
    global_instruction: str,
    promptdata: dict[str, str],
    notes: list[str],
) -> str:
    """A file that writes the project promptmap expects, then gets out of the way.

    The project is a promptmap construct — models, tests, promptdata — written
    by `promptmap.construct_to_files`, plus the two files a construct leaves
    out: `settings.yml` and `global.prompt`. Running it twice is safe: promptmap
    rewrites only what changed and deletes nothing.
    """
    classifier = _classifier_tests(tests)
    head = _header(
        [
            f"{name} — exported from the mind map, as a promptmap project.",
            "",
            "Run it:",
            "",
            _install(models) + " uvicorn",
            *_key_line(provider, models),
            "  python " + filename(name, "project") + "   # writes ./map, settings.yml, ...",
            "  promptmap run          # or: promptmap serve",
            "",
            f"settings.yml runs the models on {provider}/{model} through promptmap's",
            "LiteLLM backend. `promptmap serve` answers POST /run with",
            '  {"promptdata": {...}, "select": ["model_name"]}',
            "and returns every model's output.",
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
    extra_files = {"settings.yml": settings_yml(provider, model)}
    if global_instruction:
        extra_files["global.prompt"] = global_instruction
    if classifier:
        extra_files["client.py"] = CLASSIFY_CLIENT
    extras = "\n".join(f"    {n!r}: {_lit(src)},\n" for n, src in extra_files.items())
    return (
        f"{head}\n\n"
        "from pathlib import Path\n\n"
        "import promptmap\n\n"
        "ROOT = Path(__file__).resolve().parent\n\n"
        "# The models, tests and promptdata, as promptmap's construct JSON.\n"
        f"CONSTRUCT = {_lit(construct_json(models, tests, promptdata))}\n\n"
        "# What a construct leaves out: the backend's settings, the global instruction.\n"
        "FILES = {\n"
        f"{extras}"
        "}\n\n\n"
        "def main():\n"
        "    written = promptmap.construct_to_files(promptmap.import_from_json(CONSTRUCT, root=ROOT))\n"
        "    for name, text in FILES.items():\n"
        '        (ROOT / name).write_text(text, encoding="utf-8")\n'
        '    print(f"Wrote {len(written)} project files, and {\', \'.join(FILES)}.")\n'
        '    print("Now run:  promptmap run")\n\n\n'
        'if __name__ == "__main__":\n'
        "    main()\n"
    )


def _filename(name: str, suffix: str) -> str:
    return (_slug(name) or "mindmap") + suffix


def filename(name: str, target: str) -> str:
    return _filename(name, "_serve.py" if target == "project" else "_pipeline.py")
