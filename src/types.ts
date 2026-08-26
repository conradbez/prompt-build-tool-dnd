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
  /**
   * Where the mind map draws this node once it has been dragged. `null` means
   * "wherever the auto-layout puts it", which is how every node starts.
   */
  pos: { x: number; y: number } | null;
  /**
   * Template bullets are never sent to the LLM: their rendered text (with all
   * `ref()` inputs substituted) *is* their output. Emitted to pbt as
   * `{{ config(model_type="template") }}`.
   */
  template: boolean;
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
  /** Errors from the latest run. */
  runErrors: string[];
  /** True while a run is in flight. */
  running: boolean;
}

/** A single entry in the flattened, depth-first view of visible bullets. */
export interface FlatBullet {
  id: string;
  depth: number;
}
