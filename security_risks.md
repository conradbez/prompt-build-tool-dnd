# Security risks

What a person posting to the server (`server/main.py`) can do that they
should not. Every request is unauthenticated unless it says otherwise: `/run`
takes anything the browser sends, and the browser is not the only thing that
can post to it.

| # | Risk | Severity | Status |
| - | - | - | - |
| 1 | [Jinja injection: code execution on the master server](#1-jinja-injection) | Critical | Fixed |
| 2 | [Built-in local kinds (`execute_python`, `agent`) run on the master server](#2-built-in-local-kinds-run-on-the-master-server) | Critical | Fixed |
| 3 | [Impersonating a signed-in user's agent profile](#3-impersonating-a-signed-in-users-agent-profile) | High | Open |
| 4 | [User data leakage between profiles on the shared Agent37 instance](#4-user-data-leakage-on-the-shared-agent) | High | Open (by design, documented) |
| 5 | [Other user data leakage: files, maps, sign-in](#5-other-user-data-leakage) | Medium | Mostly mitigated |
| 6 | [Spending the server's money: Modal, Agent37](#6-spending-the-servers-money) | Medium | Open |
| 7 | [Prompt injection steering an agent](#7-prompt-injection-steering-an-agent) | Medium | Open |
| 8 | [SSRF through the classifier's `baseUrl`](#8-ssrf-through-the-classifiers-baseurl) | Low | Open |
| 9 | [Public URLs and desktop links](#9-public-urls-and-desktop-links) | Medium | Open |

---

## 1. Jinja injection

**Risk.** A bullet's text goes into its promptmap prompt as Jinja source, unescaped
(`_build_source`). promptmap renders it with a plain `jinja2.Environment`, not a
`SandboxedEnvironment` (`promptmap/executor/parser_model.py:_make_env`,
`parser_initial.py:extract_jinja_config`). Plain Jinja reaches Python's
globals, so a bullet reading

    {{ cycler.__init__.__globals__.os.popen("env").read() }}

runs a shell command **on the Railway server** and returns its output as the
bullet's answer: every env var (`AGENT37_API_KEY`, `FASTMAIL_API_TOKEN`, Modal
and bucket credentials), the SQLite file with every user's maps and sessions.
Checked locally: `{{ cycler.__init__.__globals__.os.getcwd() }}` renders the
server's working directory.

Rendering happens on the master server for prompt, template, test and agent
bullets alike, before anything is sent to Modal or Agent37. (A python bullet's
own text is not used; the code it runs comes from its child, as data. Its
`packages` field is written into a `config()` string with only `"` stripped,
which looks hard to break out of but should be validated as package names.)

**Fix.**
- Escape the person's text before it becomes template source: replace `{{`,
  `{%`, `{#` with Jinja literals (`{{ '{{' }}` …) or wrap it in
  `{% raw %}…{% endraw %}` (also escaping `{% endraw %}` inside it). The
  server's own `ref()`, `promptdata()` and `config()` lines go outside it.
- And/or render with `jinja2.sandbox.ImmutableSandboxedEnvironment` in promptmap.
  A sandbox alone is not enough: it still lets the text call `config()` (risk 2).

**Status.** Fixed. `_escape_jinja` (`server/main.py`) runs on every bullet's
text and on the global instruction after the server's own rewrites. It keeps
only the exact `{{ ref('word') }}` / `{{ promptdata("word") }}` calls the
server inserts (and `{{ prompt }}` in the global instruction); every other `{`
becomes `{{ '{' }}`, so no tag can start. Checked through `promptmap.async_run`: the
payload above comes back as literal text.

## 2. Built-in local kinds run on the master server

**Risk.** promptmap registers its own kinds on import (`promptmap/executor/builtin_kinds.py`):

- `execute_python`: `exec()` of the rendered bullet, in the server process;
- `agent`: mini-swe-agent with a `LocalEnvironment`, i.e. bash on the server.

The UI never asks for these, but `model_type` is just a `config()` key, and
the person's text can set it. `extract_jinja_config` keeps the **last** value
it sees, and the person's text comes after the server's config line, so it
wins:

    {{ config(model_type="agent37", session="a") }}      ← server's line
    hi {{ config(model_type="execute_python") }}         ← person's text
    → {'model_type': 'execute_python', 'session': 'a'}   (checked locally)

The same goes for any key: `global_instruction`, `promptfiles` (naming
another session's file keys, bypassing `_node_file_keys`), `output_format`.

**Fix.**
- Risk 1's escaping closes this too: escaped text cannot call `config()`.
- Belt and braces: after building each source, parse it with
  `extract_jinja_config` and reject the run if `model_type` is not one the
  server set (`""`, `template`, `python_modal`, `agent_modal`, `agent37`).
- Unregister `execute_python` and `agent` at server start, if promptmap allows it,
  so nothing can reach them.

**Status.** Fixed. Escaping (risk 1) stops text calling `config()`, and
`server/main.py` removes `execute_python` and `agent` from promptmap's kind registry
at import. A `model_type` naming either is now unknown, which promptmap runs as a
plain LLM call. Registered kinds: `agent37`, `agent_modal`, `python_modal`,
`template`.

## 3. Impersonating a signed-in user's agent profile

**Risk.** `/run` picks the Agent37 profile from
`accounts.user_or_none(authorization) or req.sessionId`
(`main.py`, `run`). With no token, `sessionId` is whatever the request says.
Sending `sessionId: "victim@example.com"` with no `Authorization` header gives
`profile_for("victim@example.com")`: the victim's Hermes profile, with their
memory, conversations, folders and the model key they last ran with.

**Fix.** Keep the two namespaces apart: profile from `"email:" + email` when
signed in, `"session:" + sessionId` otherwise (and reject a `sessionId`
containing `@`, or one that is not the browser's random-id shape).

**Status.** Open. Changing the prefix moves every existing profile, so
existing users start fresh unless profiles are renamed on the instance.

## 4. User data leakage on the shared agent

**Risk.** Every user's agent bullets run on one Agent37 instance
(`9c7c78hguk`, `agent37_exec.py`). Hermes profiles separate config, memory and
history, but they are **one Linux user on one disk**. An agent run by user A
can `cat ~/.hermes/profiles/*/…` and read user B's:

- model API key (written into B's profile config to run B's turns);
- conversations, memory, and every file B's nodes made;
- anything B's agent left running (servers on public ports, browser sessions
  on the shared desktop).

A malicious user only has to ask their agent to. A prompt-injected agent
(risk 7) can do it without its user asking.

**Fix.**
- Per user, an instance of their own (users can already set their own Agent37
  key in Settings); keep the shared instance for anonymous trials only.
- Or don't store users' model keys on the instance: proxy model calls through
  the server, so the instance only ever holds a short-lived per-run token.
- At minimum, say so in the UI where the shared instance is used.

**Status.** Open; documented in `agent37_exec.py`'s docstring.

## 5. Other user data leakage

| Path | Gate | Status |
| - | - | - |
| Attachments `/files/link`, `/files/delete` | key must sit under the caller's `sessionId` (`files.in_session`) | Mitigated, but the session id is a bearer secret: anyone who has it has the files |
| A run handing a bullet files | `_node_file_keys`: under this session **and** this bullet | Mitigated, except through `config(promptfiles=…)` (risk 2) |
| Saved maps `/maps` | bearer token from emailed code; per email | Mitigated |
| Sign-in codes | 6 digits, 5 guesses, 10 min, 30 s between sends | Mitigated; no per-IP limit, so many addresses can be emailed |
| Run logs and errors | streamed only to the request that ran them | Mitigated |
| The server's own secrets | env vars | Exposed by risk 1 |

## 6. Spending the server's money

**Risk.** Model calls use the person's own key, but compute does not:
python and agent bullets run on the server's Modal account, preserve-disk
agents on the server's Agent37 key. `/run` needs no sign-in, CORS is `*`, and
there is no rate limit, so anyone can loop runs on that bill. Agent37's managed
services are capped per instance (`AGENT37_BUDGET_MICROS`); Agent37 compute and
Modal are not.

**Fix.** Require sign-in for sandbox kinds, rate-limit per user and IP, and
set spend limits on the Modal workspace.

**Status.** Open.

## 7. Prompt injection steering an agent

**Risk.** Agent bullets browse the web and read upstream outputs. A page or
file can tell the agent to send what it can reach (its user's key, risk 4's
other profiles, the files in its folder) to an attacker's URL. Sandboxes have
open outbound network.

**Fix.** Mostly inherent to agents with a browser. Limit what's reachable:
risk 4's fixes, no long-lived keys on the instance, egress allow-lists where
Modal/Agent37 offer them.

**Status.** Open.

## 8. SSRF through the classifier's `baseUrl`

**Risk.** Settings → classifier `baseUrl` is any URL; the server posts to it
(`llm.py`). That lets a person make the server request internal addresses
(Railway's private network, cloud metadata) and see errors or responses.

**Fix.** Allow only `https://` to public hosts, or a fixed allow-list.

**Status.** Open.

## 9. Public URLs and desktop links

A node's *Create public URL* opens an unauthenticated port on the shared
instance; *Create browser* puts a signed desktop link (5 min) in the run log.
The desktop is the instance's, shared by every user's agent: whoever holds the
link sees and can drive whatever is on screen, including another user's
browser session.

What each platform offers:

| Link | Today | Can it be locked? |
| - | - | - |
| Agent37 desktop (port 6901) | signed URL, `a37_token` in the query, 5 min TTL | Already token-gated. The token lives on after the page opens only as long as the VNC session; shorten the TTL, and only show the link to the user who ran the node |
| Agent37 *public URL* | `public-ports`, permanent, no auth | Not by Agent37: public ports are no-auth by design. Use a signed URL for the bullet's port instead (time-limited), or have the agent's server check a secret in the URL |
| Modal desktop (port 6080) | encrypted tunnel, VNC password (8 hex chars) in the URL | Yes: Modal 1.5 has `Sandbox.create_connect_token(port=…)`, so the proxy itself refuses requests without the token. Not yet checked whether noVNC's websocket can carry it (it is sent as a header or cookie) |

**Status.** Open. Goes away for the shared desktop with per-user instances (risk 4).
