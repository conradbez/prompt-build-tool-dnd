import type { OutlineState } from '../types';

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 56;
const H_GAP = 28; // horizontal gap between sibling subtrees
const V_GAP = 44; // vertical gap between depth levels

/** One column of the auto-layout: a node plus the gap after it. */
export const SLOT_X = NODE_WIDTH + H_GAP;
/** One row of the auto-layout. */
export const SLOT_Y = NODE_HEIGHT + V_GAP;

/**
 * Grid a node settles onto when a drag ends — half a slot each way. Half rather
 * than whole so nodes can sit between columns, and half of the *slot* rather
 * than of the node so the grid lines up with wherever the auto-layout would
 * have put things: dragged and auto-placed nodes share one lattice.
 *
 * Applied on drop only (see `onNodeDragStop`), so the drag itself stays smooth.
 */
export const SNAP_GRID: [number, number] = [SLOT_X / 2, SLOT_Y / 2];

/** Round a free position onto that grid. */
export function snapToGrid(pos: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(pos.x / SNAP_GRID[0]) * SNAP_GRID[0],
    y: Math.round(pos.y / SNAP_GRID[1]) * SNAP_GRID[1],
  };
}
const RESULT_HEIGHT = 168; // extra room a node needs when it shows a run result

/**
 * Simple right-to-left tidy tree: leaves are stacked top-to-bottom, each parent
 * is centred beside its children, and depth maps to the horizontal axis — roots
 * in the rightmost column, the deepest children on the left. That is the
 * direction data runs: a child runs first and its output feeds its parent, so
 * every link reads left-to-right as input → output.
 * Multiple roots are stacked one under another. Collapsed bullets render as leaves.
 *
 * A node that shows a run result is taller, so its leaf slot is given extra
 * vertical room and its output card doesn't overlap the node below.
 */
export function layout(state: OutlineState): LaidOutNode[] {
  const placed: { id: string; y: number; depth: number }[] = [];
  let cursor = 0; // next free y

  const place = (id: string, depth: number): number => {
    const b = state.bullets[id];
    if (!b) return cursor;
    const kids = b.collapsed ? [] : b.children.filter((c) => state.bullets[c]);
    const height = NODE_HEIGHT + (state.results[id] ? RESULT_HEIGHT : 0);

    let y: number;
    if (kids.length === 0) {
      y = cursor;
      cursor += height + V_GAP;
    } else {
      const childYs = kids.map((c) => place(c, depth + 1));
      y = (childYs[0] + childYs[childYs.length - 1]) / 2;
      // A parent taller than its stack of children still needs its room.
      cursor = Math.max(cursor, y + height + V_GAP);
    }
    placed.push({ id, y, depth });
    return y;
  };

  for (const rootId of state.rootIds) place(rootId, 0);

  // Roots at x = 0, each level one column further left. Anchored on the root
  // rather than the deepest level, so adding a grandchild grows the tree
  // leftwards instead of shoving every existing column to the right.
  const auto = new Map(placed.map((p) => [p.id, { x: -p.depth * SLOT_X, y: p.y }]));

  // A dragged node keeps its spot (`bullet.pos`), and whatever hangs off it
  // comes along: an unpinned node sits where the auto-layout puts it *relative
  // to its nearest pinned ancestor*. Otherwise a child added to a node you had
  // moved would appear back where that node used to be.
  const pinnedAnchor = (id: string): string | null => {
    for (let cur = state.bullets[id]?.parentId ?? null; cur; cur = state.bullets[cur]?.parentId ?? null) {
      if (state.bullets[cur]?.pos) return cur;
    }
    return null;
  };

  return placed.map((p) => {
    const own = state.bullets[p.id].pos;
    if (own) return { id: p.id, ...own, depth: p.depth };
    const a = auto.get(p.id)!;
    const anchor = pinnedAnchor(p.id);
    if (!anchor) return { id: p.id, ...a, depth: p.depth };
    const at = state.bullets[anchor].pos!;
    const from = auto.get(anchor)!;
    return { id: p.id, x: at.x + a.x - from.x, y: at.y + a.y - from.y, depth: p.depth };
  });
}
