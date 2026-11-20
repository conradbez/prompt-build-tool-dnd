# promptmap 0.5.16 → 0.8.6 — changelog and what it means for `server/`

Pinned before: `promptmap[extras]>=0.5.16` (lock 0.5.16), `promptmap-extra-model-kinds>=0.2.0` (lock 0.2.0).
Latest: **promptmap 0.8.6** (2026-11-17), **promptmap-extra-model-kinds 0.7.19** (2026-11-16).
I built this changelog by diffing the two sdists from PyPI, because upstream publishes no CHANGELOG.

---

## Changelog

### Breaking / behavioural

| Change | Detail |
| --- | --- |
| **Models run in parallel** | 0.5.16 awaited models **one at a time**, even though the docs said otherwise. 0.8.6 starts each model as soon as its deps finish, capped by the new `max_parallel` kwarg (default **4**) on `run`/`async_run`. `on_model_start`/`on_model_done` now interleave, and results come back in finish order. In-flight models are cancelled if the caller is cancelled. |
| **`execute_python` left core** | It is now an extras kind (`promptmap_extra_model_kinds.python_exec`, entry point). |
| **`agent` rewritten** | The old `agent` (config keys `agent_dir`, `agent_backend`, `agent_mcp`, plus the opencode backend) is gone. The new `agent` runs mini-swe-agent in a scratch dir: text in, text out, files via `promptfiles` → `inputs/` and `outputs/`. opencode moved to the extras kind `agent_multi_harness`. |
| **New core kind `coding_agent`** | mini-swe-agent as a pure function: folder in, patched folder plus diff out. It reuses unchanged runs and replays finished steps (`agent_step_cache`). It **runs bash locally**. |
| **Default LLM backend = LiteLLM** | With no `client.py`, `settings.yml` (`provider`, `model`, `aliases`) drives `litellm_llm_call`. `client.py` still wins. New hard deps: `litellm==1.109.1` (pinned after a supply-chain incident), `tree-sitter-language-pack`, `questionary`; `mini-swe-agent` is now a hard dep. `import promptmap` sets `LITELLM_LOCAL_MODEL_COST_MAP=True`. |
| **Reserved config keys** | `provider`, `model`, `warm_start` and `write_folder` are now built-in keys. |
| **Cache key** | If `llm_call` has `cache_identity` / `cache_identity_for(config)`, it is prefixed to the key. A `client.py` without one keeps its old keys. |
| **File names** | The `3_a_` sequence prefix is no longer stripped. `3_a_foo.prompt` is now model `3_a_foo`. |
| Unknown `model_type` | Still raises `UnknownModelTypeError`, now with an install hint for the moved kinds. |

### New

- **Template functions**: `@promptmap.template_function("name")`, a `jinja_template_functions.py` project file, a `promptmap.template_functions` entry point, and `TemplateContext` (model, specs, DAG). One ships built in: **`org_outline(up=, down=, zoom=, lines=)`**, which renders the model's position in the DAG as a bullet tree.
- **Construct API**: `file_to_construct`, `construct_to_files`, `export_to_json` and `import_from_json` turn a whole project (models, tests, promptdata.yml, promptfiles.yml) into one object, and back.
- **ModelCall** gains `previous`, `report_cache(verdict)` and `promptfiles`. `ModelKind.config_defaults` plus `config_value()` are new, and so is `progress_listener` / `report_progress(model, step, total)`.
- **`warm_start`** config: `previous` falls back to an older template's result (`PreviousRun.same_template=False`).
- **`ModelRunResult.cache`**: a label for how the output was produced (`cache`, `cache_check`, `hit`, `replay`, `warm`, `miss`, …).
- **CLI**: interactive `init` (provider, model, key), `run --provider/--model/--threads`, `edit`, `clear-cache MODEL`, and a Claude Code skill.
- **Extras 0.7.19**:
  - New kinds: `execute_python` (moved here), `agent_multi_harness` (mini-swe-agent, opencode or pi) and `browser_use`.
  - New RAG kinds: `gemini_search`, `openai_search` and `anthropic_search`. **All three read keys from env**.
  - New `[browser]` and `[npm]` extras.
  - **No changes** to `modal_exec`, `agent37_exec`, `models` or `brave_search`. The only change in `agent_exec` is that `OPENCODE_VERSION` moved to `npm_bins`.

### Unchanged APIs the server relies on (verified)

`async_run(models_from_dict, llm_call, promptfiles, promptdata, global_instruction, select, wrap_refs, on_model_start, on_model_done)`, `register_config_keys`, `model_types._REGISTRY/get_model_kind/register_model_kind`, `run_context._NON_KEY_CONFIG`, `ModelError/ModelStatus/ModelRunResult`, `files.contains_files/iter_files/to_jsonable`, `classifier.*`, `tester.execute_tests`, `SQLiteStorageBackend`, and every `agent_exec`/`agent37_exec`/`modal_exec` helper `main.py` uses.

---

## 1) Update to match breaking changes

**Pin bump: done on this branch.** `server/pyproject.toml` now requires `promptmap[extras]>=0.8.6` and `promptmap-extra-model-kinds>=0.7.19`, and `uv.lock` is regenerated. I smoke-tested `_run` with a fake LLM:
- A graph with children, a JSON bullet, a template, `@var` and `@[[ref]]` runs.
- Outputs, prompts and the event stream look right.
- `/export` produces a script that parses.
- No code changes were needed.

Still to do:

1. **Kind denylist is out of date (security hygiene).** `main.py:62` pops only `execute_python` and `agent`. After the upgrade, the registry also holds three kinds that execute on *this* machine:
   - `coding_agent` (core);
   - `agent_multi_harness` and `browser_use` (extras, registered by the package `__init__` that `main.py:43` imports).

   User text can't set `model_type`, because `_escape_jinja` blocks it, so this is defence-in-depth. Switch to an **allowlist**: keep `""`, `template`, `python_modal`, `agent_modal` and `agent37`, and drop everything else. The comment at `main.py:58-61` is also wrong in both versions: an unknown `model_type` raises an error, it does not fall back to an LLM call.
2. **Parallelism is now real.** Up to 4 bullets run at once, including Modal and Agent37 agents. That means faster runs, but also concurrent spend and provider rate limits. Pass `max_parallel` explicitly to `async_run` (`main.py:1317`), and consider making it a Settings value.
   - Sync `llm_call` runs via `run_in_executor`, which does **not** copy contextvars. `llm.py` doesn't use any, so it's fine today. Just don't start reading `agent_exec._settings` from inside `llm_call`.
   - The README's "runs independent branches in parallel" claim is now true.
3. **Image size**: `litellm`, `tree-sitter-language-pack` and `mini-swe-agent` are now pulled into the Docker image whether or not they're used. Python 3.12 is fine.
4. Don't name any of our own config keys `model` or `provider` unless we mean promptmap's meaning (see 3a).

## 2) Offload to promptmap (delete code)

| Delete | Replace with | Size |
| --- | --- | --- |
| **`_model_input`, `_fill_vars`, `live_rendered`, and the prompt-rebuild loop in `_run`** (`main.py:791-835`, `1244-1284`, `1354-1364`) | `ModelRunResult.prompt_rendered`. I verified it is filled **even on cache hits**, with the global instruction, variables and refs already rendered. The docstring's claim that "a cached node never re-renders" is false in both versions. The value shows the `[ref]` tags the model actually saw, which is more honest. To show titles instead of `n_xxx` slugs, pass `wrap_refs=lambda name, open: f"[{'' if open else '/'}{title_of(name)}]"`. Skipped bullets keep the simple `SKIPPED_NOTE`. | ~90 lines |
| **Template passthrough** in `llm.py` (`_is_template`, lines 86-94, 139-143) and in the exported `llm_call` (`export.py`, the `model_type == "template"` branch) | Nothing. `template` has `exec_fn=None`, so promptmap never calls `llm_call` for it (true since 0.5.16; checked in code and at runtime). | ~15 lines |
| `global_instruction=False` in `TEMPLATE_CONFIG_LINE` | Nothing. The `template` kind already has `accepts_global_instruction=False`. | 1 line |
| **Provider clients in `llm.py`** for openai, anthropic and openrouter, and possibly gemini (~85 lines) | `promptmap.llm.quiet_litellm().completion(model=litellm_model(provider, model), api_key=key, messages=[…], response_format=…)`, with files built by `promptmap.llm._file_block`. Wins: attachments for **openai and anthropic** (today they raise), JSON mode everywhere, and token usage by returning `promptmap.LLMResult`. Keep the wrapper, because `litellm_llm_call` takes no `api_key` and would read **server env keys**, which breaks the "never spend our keys" rule. **Upstream ask:** add `api_key=` to `litellm_llm_call`. Then `llm.py` shrinks to about 20 lines (classifier routing plus the key). Note that `_file_block` is private and sniffs MIME by extension only. | ~85 lines |
| **Exported `client.py` with 4 hand-written provider snippets** (`export._llm_call`, ~70 lines) | Write a `settings.yml` (`provider`, `model`) and a `.env` hint, and let promptmap's LiteLLM backend run it. Keep a two-line `client.py` only for `classify_call` when there are classifier tests. | ~60 lines |
| **`export.project`'s self-writing script** | `promptmap.export_to_json(construct)` at export time. The emitted file becomes `promptmap.construct_to_files(promptmap.import_from_json(JSON))`, which also gets `promptdata.yml` handled natively. | moderate |

Keep for now: the `_run_context._NON_KEY_CONFIG` patch and the `_with_bullet_model` exec_fn wrapper. Both still work, but they reach into private APIs. Ask upstream for:
- a public "non-key config keys" hook;
- extras agent kinds that read the bullet's model via `config_value(spec, "model")`.

## 3) Simpler, more promptmap-shaped constructs

a. **`llm_model` → promptmap's own `model` config key.** It's now a reserved key that the LiteLLM backend reads, so `register_config_keys(LLM_MODEL_VAR)` goes away. `llm.py` reads `config["model"]`, and exported projects keep working unchanged: the same `{{ config(model="…") }}` lines are honoured by promptmap's default backend. To keep the "switching models doesn't bust the cache" behaviour, add `"model"` instead of `"llm_model"` to the `_NON_KEY_CONFIG` patch.

b. **Use `org_outline()` for tree context.** The app *is* a tree, and promptmap now ships a function that tells a model where it sits in the DAG. An optional per-bullet "knows its place" toggle could emit `{{ org_outline(up=1, down=1) }}`. That needs one more pattern in `_ALLOWED_JINJA`. The outline uses model names, so it pairs with readable names (see the export's `model_names`).

c. **Search bullets on the user's own provider.** `gemini_search`, `openai_search` and `anthropic_search` would remove the need for a server-side `BRAVE_API_KEY` and use grounded search from the provider the user already chose. Blocker: they read keys from env. Either ask upstream for an `api_key=` parameter, or register thin wrappers (`promptmap.register_rag_kind`) that take the run's key from a contextvar set in `_run`.

d. **Show `ModelRunResult.cache`** (the label) in the `done` event instead of only the `cached` bool. That way "cached" vs "reused" is visible next to each bullet.

e. **Make agent progress structured.** `report_progress(model, step, total)` with a `progress_listener` contextvar is the new standard channel. If `agent_exec` adopted it upstream, the UI could show "step 7/30" instead of parsing log lines. Our `on_log` stays until then.

f. **Not worth adopting here:** the core `agent` / `coding_agent`, `agent_multi_harness` and `browser_use`, because they all run on the server host. Python and agent bullets should stay on `python_modal` / `agent_modal` / `agent37`.

### Suggested order

1. Merge the pin bump plus the allowlist and an explicit `max_parallel` (small, low risk).
2. Replace `_model_input` with `prompt_rendered` and delete the dead template passthrough (biggest deletion, easy to verify in the UI).
3. Rename `llm_model` → `model`, then move `llm.py` onto litellm with the per-request key.
4. Rework export onto `settings.yml` + Construct.
5. Optional features: `org_outline`, provider search, cache labels.
