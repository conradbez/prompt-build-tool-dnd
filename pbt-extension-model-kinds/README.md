# pbt-extension-model-kinds

Extra model kinds for [pbt](https://pypi.org/project/prompt-build-tool/):

| `model_type`   | Module          | Runs                                                   |
|----------------|-----------------|--------------------------------------------------------|
| `python_modal` | `modal_exec`    | the bullet's upstream Python in a Modal sandbox        |
| `agent_modal`  | `agent_exec`    | an OpenCode agent (plus optional MCP server) on Modal  |
| `agent37`      | `agent37_exec`  | a Hermes agent on an Agent37 workspace (`agent37.md`)  |

Installing the package is enough: pbt >= 0.5.8 finds the kinds through the
`pbt.model_kinds` entry point group and loads them on first use. Nothing has
to import it.

Deployment configuration (Modal credentials, image packages, timeouts) is read
from the environment — see each module's docstring.

API keys are the run's secrets, never config or environment. The agent kinds
read the provider key from `call.secrets`, named as in `models.ENV_KEYS`, and
`agent37` also reads `AGENT37_API_KEY`:

```python
pbt.run(..., secrets={"GEMINI_API_KEY": key})
```

```sh
pbt run --secret GEMINI_API_KEY        # reads the env var of that name
```

A host can also pick the provider, model, step limit and log sink for a run with
`agent_exec.use_run(RunSettings(...))`. Without it, the first provider whose
key was passed answers, using that provider's default model.
