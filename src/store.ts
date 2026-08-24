import { useSyncExternalStore } from 'react';
import { nanoid } from 'nanoid';
import type { Bullet, Field, Focus, OutlineState, FlatBullet } from './types';

/**
 * A tiny external store shared by the outline (right) and the mind map (left).
 * Both panels read the same state and dispatch the same actions, so a change
 * on one side is always reflected on the other.
 */

function makeBullet(partial: Partial<Bullet> & { id: string }): Bullet {
  return {
    title: '',
    body: '',
    children: [],
    parentId: null,
    collapsed: false,
    refs: [],
    ...partial,
  };
}

function seed(): OutlineState {
  const root = makeBullet({ id: nanoid(), title: 'Welcome', body: 'Edit me — this is the body. Press Enter here to add a bullet below.' });
  const a = makeBullet({ id: nanoid(), title: 'Left is a mind map', body: 'Top bullets flow down to their children.', parentId: root.id });
  const b = makeBullet({ id: nanoid(), title: 'Right is an outline', body: 'Workflowy-style bullets. Drag the divider to resize.', parentId: root.id });
  const b1 = makeBullet({ id: nanoid(), title: 'Reference bullets', body: 'Type @ to mention another bullet — a dashed link appears on the map.', parentId: b.id });
  root.children = [a.id, b.id];
  b.children = [b1.id];
  return {
    bullets: { [root.id]: root, [a.id]: a, [b.id]: b, [b1.id]: b1 },
    rootIds: [root.id],
    focus: { id: root.id, field: 'title', caret: 'end' },
    selectedId: root.id,
    results: {},
    runErrors: [],
    running: false,
  };
}

let state: OutlineState = seed();
const listeners = new Set<() => void>();

function emit(next: OutlineState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------------------
// Derived selectors
// ---------------------------------------------------------------------------

/** Depth-first flatten of visible bullets (collapsed subtrees are skipped). */
export function flatten(s: OutlineState = state): FlatBullet[] {
  const out: FlatBullet[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const b = s.bullets[id];
      if (!b) continue;
      out.push({ id, depth });
      if (!b.collapsed) walk(b.children, depth + 1);
    }
  };
  walk(s.rootIds, 0);
  return out;
}

/** Ordered list of focus targets: each visible bullet contributes title then body. */
export function focusOrder(s: OutlineState = state): Focus[] {
  return flatten(s).flatMap(({ id }): Focus[] => [
    { id, field: 'title' },
    { id, field: 'body' },
  ]);
}

/** All bullets as flat run payloads (id, title, body, refs) for the server. */
export function buildNodePayloads(s: OutlineState = state) {
  return Object.values(s.bullets).map((b) => ({
    id: b.id,
    title: b.title,
    body: b.body,
    refs: b.refs.filter((r) => s.bullets[r]),
  }));
}

function siblingsOf(s: OutlineState, id: string): { list: string[]; index: number; parentId: string | null } {
  const b = s.bullets[id];
  const list = b.parentId ? s.bullets[b.parentId].children : s.rootIds;
  return { list, index: list.indexOf(id), parentId: b.parentId };
}

// ---------------------------------------------------------------------------
// Mutations — each returns a fresh OutlineState (structural, shallow copies)
// ---------------------------------------------------------------------------

function clone(s: OutlineState): OutlineState {
  return { ...s, bullets: { ...s.bullets } };
}

function setChildren(s: OutlineState, parentId: string | null, children: string[]) {
  if (parentId === null) {
    s.rootIds = children;
  } else {
    s.bullets[parentId] = { ...s.bullets[parentId], children };
  }
}

function collectDescendants(s: OutlineState, id: string, acc: string[]) {
  for (const c of s.bullets[id].children) {
    acc.push(c);
    collectDescendants(s, c, acc);
  }
}

export const actions = {
  setFocus(focus: Focus | null) {
    const next = clone(state);
    next.focus = focus;
    if (focus) next.selectedId = focus.id;
    emit(next);
  },

  select(id: string) {
    if (state.selectedId === id) return;
    emit({ ...state, selectedId: id });
  },

  /** Move focus to the previous (-1) or next (+1) editor in reading order. */
  moveFocus(from: Focus, dir: -1 | 1) {
    const order = focusOrder(state);
    const idx = order.findIndex((f) => f.id === from.id && f.field === from.field);
    if (idx === -1) return;
    const target = order[idx + dir];
    if (!target) return;
    actions.setFocus({ ...target, caret: dir === 1 ? 'start' : 'end' });
  },

  setText(id: string, field: Field, value: string) {
    const b = state.bullets[id];
    if (!b || b[field] === value) return;
    const next = clone(state);
    next.bullets[id] = { ...b, [field]: value };
    emit(next);
  },

  toggleCollapse(id: string) {
    const b = state.bullets[id];
    if (!b || b.children.length === 0) return;
    const next = clone(state);
    next.bullets[id] = { ...b, collapsed: !b.collapsed };
    emit(next);
  },

  addRef(sourceId: string, targetId: string) {
    const b = state.bullets[sourceId];
    if (!b || sourceId === targetId || b.refs.includes(targetId)) return;
    const next = clone(state);
    next.bullets[sourceId] = { ...b, refs: [...b.refs, targetId] };
    emit(next);
  },

  /** Create a new empty sibling directly after `id`; focus its title. */
  addSiblingAfter(id: string): string {
    const next = clone(state);
    const { list, index, parentId } = siblingsOf(next, id);
    const nb = makeBullet({ id: nanoid(), parentId });
    next.bullets[nb.id] = nb;
    const newList = [...list];
    newList.splice(index + 1, 0, nb.id);
    setChildren(next, parentId, newList);
    next.focus = { id: nb.id, field: 'title', caret: 'end' };
    next.selectedId = nb.id;
    emit(next);
    return nb.id;
  },

  /** Make `id` a child of its previous sibling. */
  indent(id: string, field: Field) {
    const { list, index } = siblingsOf(state, id);
    if (index <= 0) return; // no previous sibling to nest under
    const next = clone(state);
    const prevId = list[index - 1];
    const b = next.bullets[id];
    // remove from current siblings
    const newList = list.filter((x) => x !== id);
    setChildren(next, b.parentId, newList);
    // append to previous sibling, un-collapsing it
    const prev = { ...next.bullets[prevId], collapsed: false };
    prev.children = [...prev.children, id];
    next.bullets[prevId] = prev;
    next.bullets[id] = { ...b, parentId: prevId };
    next.focus = { id, field, caret: 'end' };
    emit(next);
  },

  /** Move `id` up to become a sibling of its parent, just after it. */
  outdent(id: string, field: Field) {
    const b = state.bullets[id];
    if (!b.parentId) return; // already at top level
    const next = clone(state);
    const parent = next.bullets[b.parentId];
    const grandParentId = parent.parentId;
    // remove from parent's children
    setChildren(next, parent.id, parent.children.filter((x) => x !== id));
    // insert after parent among grandparent's children
    const gList = grandParentId ? next.bullets[grandParentId].children : next.rootIds;
    const pIndex = gList.indexOf(parent.id);
    const newG = [...gList];
    newG.splice(pIndex + 1, 0, id);
    setChildren(next, grandParentId, newG);
    next.bullets[id] = { ...next.bullets[id], parentId: grandParentId };
    next.focus = { id, field, caret: 'end' };
    emit(next);
  },

  /** Delete an empty bullet (no children); focus the previous target. */
  deleteBullet(id: string) {
    const b = state.bullets[id];
    if (!b || b.children.length > 0) return;
    const order = focusOrder(state);
    const idx = order.findIndex((f) => f.id === id && f.field === 'title');
    const prev = idx > 0 ? order[idx - 1] : null;
    const next = clone(state);
    const { list } = siblingsOf(next, id);
    setChildren(next, b.parentId, list.filter((x) => x !== id));
    // scrub references to the deleted bullet
    for (const other of Object.values(next.bullets)) {
      if (other.refs.includes(id)) {
        next.bullets[other.id] = { ...other, refs: other.refs.filter((r) => r !== id) };
      }
    }
    delete next.bullets[id];
    const target = prev && next.bullets[prev.id] ? { ...prev, caret: 'end' as const } : null;
    next.focus = target;
    next.selectedId = target ? target.id : null;
    emit(next);
  },

  setRunning(running: boolean) {
    emit({ ...state, running, ...(running ? { runErrors: [] } : {}) });
  },

  setRunResult(outputs: Record<string, string>, errors: string[]) {
    emit({ ...state, results: outputs, runErrors: errors, running: false });
  },

  /** Reparent `id` under `newParentId` (used by mind-map / future drag ops). */
  reparent(id: string, newParentId: string | null) {
    if (id === newParentId) return;
    const b = state.bullets[id];
    if (!b) return;
    // guard against cycles
    if (newParentId) {
      const desc: string[] = [id];
      collectDescendants(state, id, desc);
      if (desc.includes(newParentId)) return;
    }
    const next = clone(state);
    const { list } = siblingsOf(next, id);
    setChildren(next, b.parentId, list.filter((x) => x !== id));
    const targetList = newParentId ? next.bullets[newParentId].children : next.rootIds;
    setChildren(next, newParentId, [...targetList, id]);
    next.bullets[id] = { ...next.bullets[id], parentId: newParentId };
    emit(next);
  },
};

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export function useOutline(): OutlineState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function getState(): OutlineState {
  return state;
}
