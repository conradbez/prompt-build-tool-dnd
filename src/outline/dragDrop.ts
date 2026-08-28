/**
 * Where a dragged bullet would land — the geometry behind the drop indicator.
 *
 * Modelled on Workflowy: you grab a bullet by its dot, the row stays where it
 * is (highlighted), and a line marks the insertion point. The line's **left
 * edge is the nesting level**, so moving the pointer sideways during a drag
 * chooses the depth, exactly as `Tab`/`Shift+Tab` would afterwards.
 *
 * The sideways reading is **relative to where the drag started**, not to the
 * pointer's absolute x: a nudge of half an indent is one level, so you can
 * change the nesting with a small wrist movement instead of dragging the
 * pointer all the way to the target indent.
 *
 * Pure functions only, so the rules are testable without a DOM.
 */

/** A visible row, measured. */
export interface RowRect {
  id: string;
  depth: number;
  top: number;
  bottom: number;
}

export interface DropTarget {
  /** Bullet the dragged one becomes a child of, or null for top level. */
  parentId: string | null;
  /** Position among that parent's children. */
  index: number;
  /** Nesting level the indicator should be drawn at. */
  depth: number;
  /** Where the indicator line sits, in the same space as the row rects. */
  y: number;
}

export interface Tree {
  parentOf: (id: string) => string | null;
  childrenOf: (parentId: string | null) => string[];
}

/** Pixels of indent per nesting level — matches the row's `marginLeft`. */
export const INDENT = 22;

/** Sideways travel that shifts the drop one level. Half an indent: enough to
 *  be deliberate, small enough to be a nudge. */
export const SHIFT_STEP = INDENT / 2;

/**
 * Work out the drop target for a pointer at (x, y).
 *
 * `rows` must already exclude the dragged bullet and its descendants: you
 * can't drop a subtree inside itself, so those rows aren't candidates.
 */
export function computeDrop(
  rows: RowRect[],
  pointerX: number,
  pointerY: number,
  /** Where the drag began — sideways movement is measured from here. */
  originX: number,
  tree: Tree,
): DropTarget | null {
  if (rows.length === 0) return { parentId: null, index: 0, depth: 0, y: 0 };

  // How many rows the pointer has passed the middle of: that's where it lands.
  let at = 0;
  while (at < rows.length && pointerY > (rows[at].top + rows[at].bottom) / 2) at++;

  const prev = at > 0 ? rows[at - 1] : null;
  const next = at < rows.length ? rows[at] : null;

  // Depth is bounded by the neighbours: at most one level deeper than the row
  // above (its new child), at least as deep as the row below (whose parent
  // must stay reachable).
  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  // Without any sideways movement a bullet lands level with the row above;
  // each nudge of `SHIFT_STEP` moves it one level in or out from there.
  const base = prev ? prev.depth : 0;
  const shift = Math.round((pointerX - originX) / SHIFT_STEP);
  const depth = Math.max(minDepth, Math.min(maxDepth, base + shift));

  const y = prev ? prev.bottom : rows[0].top;

  if (!prev) return { parentId: null, index: 0, depth: 0, y };

  if (depth === prev.depth + 1) {
    // First child of the row above.
    return { parentId: prev.id, index: 0, depth, y };
  }

  // Otherwise walk up from the row above to the level being dropped at, and
  // land just after that ancestor.
  let node = prev.id;
  let d = prev.depth;
  while (d > depth) {
    const up = tree.parentOf(node);
    if (up === null) break;
    node = up;
    d--;
  }
  const parentId = tree.parentOf(node);
  const index = tree.childrenOf(parentId).indexOf(node) + 1;
  return { parentId, index, depth, y };
}
