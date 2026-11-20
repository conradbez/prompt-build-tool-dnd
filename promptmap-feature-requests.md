# promptmap feature requests

These come from [prompt-build-tool-dnd](https://github.com/conradbez/prompt-build-tool-dnd), a hosted app that runs a mind map as a promptmap pipeline. Each person who uses the app sends their own provider key with each request, and the server must never fall back to keys in its own environment.

Each request replaces a workaround in that server that reaches into promptmap internals. Line numbers are from promptmap 0.8.6 and promptmap-extra-model-kinds 0.7.19.

---

## 1. An `api_key` option on `litellm_llm_call`

### Feature
`promptmap.llm.litellm_llm_call(provider, model, aliases=None, api_key=None)`. When `api_key` is given, it is passed to `litellm.completion`. When it is not, nothing changes: LiteLLM reads the key from the environment as it does today.

### Reason
A server that runs pipelines for many users has a different key per request, so it can't use environment variables. Today such a server can't use the default backend at all. It has to copy it instead: the `provider/model` string, the per-prompt `config(model=…)` and alias handling, the file blocks and the `LLMResult` wrapping, just to add one argument to `completion`.

### Minimal change
`promptmap/llm.py`:

```diff
 def litellm_llm_call(
-    provider: str, model: str, aliases: dict[str, tuple[str, str]] | None = None,
+    provider: str, model: str, aliases: dict[str, tuple[str, str]] | None = None,
+    api_key: str | None = None,
 ) -> Callable:
@@ def llm_call(prompt: str, files: list | None = None, config: dict | None = None):
-        response = quiet_litellm().completion(model=target, messages=[{"role": "user", "content": content}])
+        response = quiet_litellm().completion(
+            model=target,
+            messages=[{"role": "user", "content": content}],
+            **({"api_key": api_key} if api_key else {}),
+        )
```

### Not part of this request
- No change to `settings.yml`, the CLI or `cache_identity`. The key must stay out of the cache key, and it does: it never touches `config` or the identity.
- No JSON mode or `max_tokens` handling. Callers that need those can keep wrapping.

---

## 2. A public way to keep a `config()` key out of the cache key

### Feature
`promptmap.exclude_from_cache_key(*keys)`. Each key named stops counting toward the prompt cache key, the way `cache` already doesn't.

### Reason
The cache key is the rendered prompt plus every `config()` value except those in the private `run_context._NON_KEY_CONFIG` (`run_context.py:75`). An app may want a setting to *not* invalidate cached answers. For example, switching a bullet's `model` keeps the answers already paid for. The only way to get that today is to overwrite the private set.

If that private name is ever renamed, the overwrite just creates an unused attribute. Nothing errors; caching silently changes behaviour.

### Minimal change
`promptmap/executor/run_context.py`:

```diff
 _NON_KEY_CONFIG = frozenset({"cache"})
+
+
+def exclude_from_cache_key(*keys: str) -> None:
+    """Leave these config() keys out of the prompt cache key, like ``cache``."""
+    global _NON_KEY_CONFIG
+    _NON_KEY_CONFIG = _NON_KEY_CONFIG | frozenset(keys)
```

`promptmap/__init__.py`: re-export it next to `register_config_keys` and add it to `__all__`.

### Not part of this request
- No per-model or per-run variant, and no change to `cache_identity`.
- No changes to `register_config_keys`. A combined `register_config_keys(..., cache_key=False)` would be nicer, but it touches the parser module too.

---

## 3. `agent_modal` and `agent37` honour a bullet's `config(model=…)`

### Feature
An agent bullet that sets `{{ config(model="…") }}` runs its agent on that model. A bullet that doesn't set one keeps using the run's model (`RunSettings.model`), exactly as today.

### Reason
`model` is promptmap's standard per-prompt setting, and the default LLM backend already honours it. The two extras agent kinds don't call `call.llm`, though: they hand a model to an agent running elsewhere (OpenCode on Modal, Hermes on Agent37), and that model always comes from the run-wide settings (`agent_exec.py:627`, `agent37_exec.py:867`). Per-bullet models therefore silently don't apply to agents, in apps and in exported projects alike.

The app's workaround wraps each kind's `exec_fn` and swaps the model into the private `agent_exec._settings` around every call.

### Minimal change
Read the bullet's setting first and fall back to the run's. promptmap 0.8's `config_value` helper exists for exactly this.

`promptmap_extra_model_kinds/agent_exec.py`, in `execute`:

```diff
+    model = promptmap.model_types.config_value(call.spec, "model") or run.model
     env = _secret_env(
-        run.provider, run.api_key, steps_for(own) if own > 0 else run.steps, run.model
+        run.provider, run.api_key, steps_for(own) if own > 0 else run.steps, model
     )
```

`promptmap_extra_model_kinds/agent37_exec.py`, in `execute`:

```diff
-    provider = _provider(run.provider, run.api_key, run.model)
+    model = promptmap.model_types.config_value(call.spec, "model") or run.model
+    provider = _provider(run.provider, run.api_key, model)
```

### Not part of this request
- No per-bullet `provider` override; the agent still uses the run's provider and key.
- No change to `RunSettings`, `use_run` or the `AGENT_MODEL` environment override.
- No cache-key change. `model` is in `config`, so it already counts toward the key unless the app excludes it (see #2).
