export type Field = 'title' | 'body';

export interface Bullet {
  id: string;
  /** Bold first line. */
  title: string;
  /** Free text under the title. */
  body: string;
  /** Ordered child bullet ids (many children to one parent). */
  children: string[];
  parentId: string | null;
  collapsed: boolean;
  /** Ids of other bullets referenced from this one (via the `@` mention). */
  refs: string[];
}

export interface Focus {
  id: string;
  field: Field;
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
