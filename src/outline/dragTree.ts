/**
 * The outline as dragology sees it: a tree of the *visible* bullets, and every
 * place one of them could be dropped.
 *
 * Dragology is model-driven — a drag declares the states it may end in, the
 * library renders each one and lands on whichever puts the dragged bullet
 * closest to the pointer. So a drop target here isn't geometry, it's a whole
 * alternative outline: the bullet (with its subtree) re-inserted somewhere.
 * Depth comes for free — a deeper insertion draws the bullet further right, so
 * moving the pointer sideways chooses the nesting level, as in Workflowy.
 *
 * Pure functions only, so the rules are testable without a DOM.
 */
import type { OutlineState } from '../types';

/** Pixels of indent per nesting level. */
export const INDENT = 22;

export interface TreeNode {
  id: string;
  children: TreeNode[];
}

/** Where a drop puts the dragged bullet: `index` counts siblings *without* it. */
export interface Move {
  id: string;
  parentId: string | null;
  index: number;
}

export interface DragState {
  roots: TreeNode[];
  /** Set on a candidate drop state; absent on the outline as it stands. */
  move?: Move;
}

/** The visible outline (collapsed bullets show no children). */
export function visibleTree(s: OutlineState): TreeNode[] {
  const walk = (ids: string[]): TreeNode[] =>
    ids
      .filter((id) => s.bullets[id])
      .map((id) => ({ id, children: s.bullets[id].collapsed ? [] : walk(s.bullets[id].children) }));
  return walk(s.rootIds);
}

/** A cheap structural fingerprint, so the tree is rebuilt only when it changes. */
export function treeKey(nodes: TreeNode[]): string {
  return nodes.map((n) => (n.children.length ? `${n.id}(${treeKey(n.children)})` : n.id)).join(',');
}

function remove(nodes: TreeNode[], id: string): { rest: TreeNode[]; removed: TreeNode | null } {
  let removed: TreeNode | null = null;
  const walk = (list: TreeNode[]): TreeNode[] =>
    list.flatMap((n) => {
      if (n.id === id) {
        removed = n;
        return [];
      }
      return [{ ...n, children: walk(n.children) }];
    });
  const rest = walk(nodes);
  return { rest, removed };
}

/**
 * Every outline the dragged bullet could be dropped into. `canTake(parentId)`
 * vetoes parents that refuse another child (a python bullet holds one).
 */
export function dropStates(
  roots: TreeNode[],
  id: string,
  canTake: (parentId: string | null) => boolean,
): DragState[] {
  const { rest, removed } = remove(roots, id);
  if (!removed) return [];
  const out: DragState[] = [];

  // Insert into `list` (the children of `parentId`) at each position, and
  // recurse into each child — `rebuild` wraps a changed list back into the
  // whole tree.
  const visit = (list: TreeNode[], parentId: string | null, rebuild: (l: TreeNode[]) => TreeNode[]) => {
    if (canTake(parentId)) {
      for (let i = 0; i <= list.length; i++) {
        out.push({
          roots: rebuild([...list.slice(0, i), removed, ...list.slice(i)]),
          move: { id, parentId, index: i },
        });
      }
    }
    list.forEach((child, i) =>
      visit(child.children, child.id, (l) =>
        rebuild(list.map((c, j) => (j === i ? { ...c, children: l } : c))),
      ),
    );
  };
  visit(rest, null, (l) => l);
  return out;
}

/**
 * The index `actions.moveTo` wants. It counts the bullet's old slot when it
 * stays under the same parent; `Move.index` doesn't.
 */
export function moveToIndex(s: OutlineState, move: Move): number {
  const b = s.bullets[move.id];
  if (!b || b.parentId !== move.parentId) return move.index;
  const list = move.parentId ? s.bullets[move.parentId].children : s.rootIds;
  return move.index >= list.indexOf(move.id) ? move.index + 1 : move.index;
}
