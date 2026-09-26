/**
 * What a bullet *is*, which decides how the server runs it:
 *
 * - `prompt`   — sent to the LLM. The default.
 * - `template` — never sent: its rendered text, with every upstream output
 *   substituted in, *is* its output. Emitted to pbt as
 *   `{{ config(model_type="template") }}`.
 * - `python`   — its text is Python, run in a Modal sandbox rather than on the
 *   server. Whatever it prints is its output, and the upstream outputs arrive
 *   as `inputs`. Emitted as `{{ config(model_type="python_modal") }}`.
 * - `agent`    — its rendered text is a *task* for a coding agent
 *   (OpenCode) working in a Modal sandbox with its own tools and, optionally, an
 *   MCP server's tools. Its output is `{output, logs, run_time}`: the answer,
 *   the run end to end on Modal, and how long it took. Emitted as
 *   `{{ config(model_type="agent_modal") }}`.
 * - `test`     — its text is an *assertion* about the bullets connected into it
 *   (children or `@` references). The model is asked for a verdict rather than
 *   an answer, and the node shows it: see `TestStatus`. A test's output never
 *   flows onward — it checks the graph from the side.
 */
export type BulletKind = 'prompt' | 'template' | 'python' | 'agent' | 'test';

/**
 * Where a test bullet stands after the latest run:
 *
 * - `pass`    — green: the assertion held.
 * - `fail`    — red: it did not, or the check itself errored.
 * - `skipped` — "not run": something it checks failed, so it never ran.
 *
 * A test with no entry is grey — it has not run yet, or has nothing connected
 * to check.
 */
export type TestStatus = 'pass' | 'fail' | 'skipped';

/**
 * Who decides a test bullet:
 *
 * - `llm`        — the run's model reads the assertion and the material and
 *   answers pass or fail.
 * - `classifier` — a classifier (TypeSafe's Jev, or a local Ollaya) answers the
 *   assertion as a yes/no question with P(yes); the test passes when that
 *   reaches `Bullet.threshold`. Set up in Settings → Classifier.
 */
export type TestJudge = 'llm' | 'classifier';

/**
 * What a python bullet shows instead of text. It has none: it is an operator,
 * not an editor — it runs what its one child produced, so there is nothing on
 * it for a person to write.
 */
export const PYTHON_CAPTION = 'Runs code from child';

/** A file attached to a bullet, held in the server's bucket. */
export interface FileRef {
  /** Object key — it carries the owning bullet's id as its prefix. */
  key: string;
  /** The name it was uploaded under, for showing to a person. */
  name: string;
}

export interface Bullet {
  id: string;
  /**
   * The bullet's text, written in markdown. There is no separate title: the
   * first line is simply the first line, and anything that needs to stand out
   * says so in markdown (`# heading`, `**bold**`).
   */
  text: string;
  /** Ordered child bullet ids (many children to one parent). */
  children: string[];
  parentId: string | null;
  collapsed: boolean;
  /** Ids of other bullets referenced from this one (via the `@` mention). */
  refs: string[];
  /** Files attached to this bullet, sent to the LLM with its prompt. */
  files: FileRef[];
  /**
   * Where the mind map draws this node once it has been dragged. `null` means
   * "wherever the auto-layout puts it", which is how every node starts.
   */
  pos: { x: number; y: number } | null;
  /** What running this bullet does — see `BulletKind`. */
  kind: BulletKind;
  /**
   * Enforce JSON: emitted to pbt as `{{ config(output_format="json") }}`, which
   * makes it *validate* the answer as JSON rather than merely ask for one — a
   * bullet that comes back as prose fails instead of passing the prose on. The
   * parsed value is what flows downstream.
   */
  jsonOutput: boolean;
  /**
   * An agent bullet's MCP server: the command that starts it over stdio, e.g.
   * `uvx some-mcp-server` or `npx -y @scope/server`. Empty means none — the
   * agent works with bash alone. Ignored on every other kind.
   */
  mcpServer: string;
  /**
   * A python bullet's extra sandbox packages, comma-separated, e.g.
   * `beautifulsoup4, scipy==1.*` — installed on top of the server's own before
   * it runs. Empty means none. Ignored on every other kind.
   */
  packages: string;
  /** A test bullet's judge — see `TestJudge`. Ignored on every other kind. */
  judge: TestJudge;
  /** A classifier-judged test passes when P(yes) ≥ this, 0–1. */
  threshold: number;
}

export interface Focus {
  id: string;
  /** Where to place the caret once the element is focused. */
  caret?: 'start' | 'end';
}

export interface OutlineState {
  bullets: Record<string, Bullet>;
  /** Top-level bullet ids, in order. */
  rootIds: string[];
  /** Which editor should hold the caret. Drives cross-panel focus. */
  focus: Focus | null;
  /** Highlighted bullet, shared between the outline and the mind map. */
  selectedId: string | null;
  /** Latest run results, keyed by bullet id. */
  results: Record<string, string>;
  /** Each test bullet's verdict from the latest run — see `TestStatus`. */
  tests: Record<string, TestStatus>;
  /** What each bullet was actually sent last run — its text plus its inputs. */
  prompts: Record<string, string>;
  /** Errors from the latest run. */
  runErrors: string[];
  /** True while a run is in flight. */
  running: boolean;
  /**
   * Whose run is open in the answer modal, if any. It lives in the store
   * rather than in one panel because both the outline and the mind map open
   * the same modal, and only one of them is on screen at a time.
   */
  openResultId: string | null;
  /** Whose settings modal is open, if any — kind, JSON, packages, MCP. */
  openSettingsId: string | null;
}

/** A single entry in the flattened, depth-first view of visible bullets. */
export interface FlatBullet {
  id: string;
  depth: number;
}
