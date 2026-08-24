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
const V_GAP = 60; // vertical gap between depth levels

/**
 * Simple top-down tidy tree: leaves are packed left-to-right, each parent is
 * centred over its children, and depth maps to the vertical axis. Multiple
 * roots are laid out side by side. Collapsed bullets render as leaves.
 */
export function layout(state: OutlineState): LaidOutNode[] {
  const nodes: LaidOutNode[] = [];
  let cursor = 0; // next free leaf slot (in node-width units)

  const slot = NODE_WIDTH + H_GAP;

  const place = (id: string, depth: number): number => {
    const b = state.bullets[id];
    if (!b) return cursor * slot;
    const kids = b.collapsed ? [] : b.children.filter((c) => state.bullets[c]);

    let x: number;
    if (kids.length === 0) {
      x = cursor * slot;
      cursor += 1;
    } else {
      const childXs = kids.map((c) => place(c, depth + 1));
      x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }
    nodes.push({ id, x, y: depth * (NODE_HEIGHT + V_GAP), depth });
    return x;
  };

  for (const rootId of state.rootIds) place(rootId, 0);
  return nodes;
}
