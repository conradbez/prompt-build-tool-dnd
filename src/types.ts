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
 */
export type BulletKind = 'prompt' | 'template' | 'python';

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
}

/** A single entry in the flattened, depth-first view of visible bullets. */
export interface FlatBullet {
  id: string;
  depth: number;
}
