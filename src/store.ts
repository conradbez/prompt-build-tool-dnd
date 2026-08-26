import { useSyncExternalStore } from 'react';
import { nanoid } from 'nanoid';
import type { Bullet, Focus, OutlineState, FlatBullet } from './types';
import { mentionIds, mentionToken, resolveMentions, stripMention } from './lib/mentions';

/**
 * A tiny external store shared by the outline (right) and the mind map (left).
 * Both panels read the same state and dispatch the same actions, so a change
 * on one side is always reflected on the other.
 */

function makeBullet(partial: Partial<Bullet> & { id: string }): Bullet {
  return {
    text: '',
    children: [],
    parentId: null,
    collapsed: false,
    refs: [],
    pos: null,
    template: false,
    ...partial,
  };
}

const DOC_KEY = 'wm.doc.v4';
// Shapes this prototype has outgrown. They are wiped on load, not migrated.
const STALE_KEYS = ['wm.doc.v1', 'wm.doc.v2', 'wm.doc.v3'];

function fresh(): { bullets: Record<string, Bullet>; rootIds: string[] } {
  const root = makeBullet({
    id: nanoid(),
    text:
      '# Find best fruit\nUsing the fruit list and the country assessment below, name the ' +
      '**single best** fruit and justify it in two sentences.',
  });
  const a = makeBullet({
    id: nanoid(),
    text: '## List 10 fruits\nList 10 fruits, one per line, no commentary.',
    parentId: root.id,
  });
  const b = makeBullet({
    id: nanoid(),
    text:
      '## Assess fruits for a random country\n' +
      `Pick a random country. For each fruit in ${mentionToken(a.id)}, assess the metrics ` +
      'for that fruit\u2019s growth there and its nutritional suitability for maximising ' +
      'calories with minimal variance. Score each out of 10 in a short table.',
    parentId: root.id,
    refs: [a.id],
  });
  root.children = [a.id, b.id];
  return { bullets: { [root.id]: root, [a.id]: a, [b.id]: b }, rootIds: [root.id] };
}

/** Load a saved document, tolerating older/partial shapes; null if none/invalid. */
function loadDoc(): { bullets: Record<string, Bullet>; rootIds: string[] } | null {
  try {
    for (const k of STALE_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(DOC_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || !d.bullets || !Array.isArray(d.rootIds) || d.rootIds.length === 0) {
      return null;
    }
    const bullets: Record<string, Bullet> = {};
    for (const [id, raw] of Object.entries(d.bullets as Record<string, Record<string, unknown>>)) {
      bullets[id] = makeBullet({
        id,
        text: typeof raw.text === 'string' ? raw.text : '',
        children: Array.isArray(raw.children) ? (raw.children as string[]) : [],
        parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
        collapsed: !!raw.collapsed,
        refs: Array.isArray(raw.refs) ? (raw.refs as string[]) : [],
        pos: isPos(raw.pos) ? raw.pos : null,
        template: !!raw.template,
      });
    }
    return { bullets, rootIds: d.rootIds.filter((id: string) => bullets[id]) };
  } catch {
    return null;
  }
}

function isPos(v: unknown): v is { x: number; y: number } {
  return !!v && typeof v === 'object' && typeof (v as any).x === 'number' && typeof (v as any).y === 'number';
}

function saveDoc(s: OutlineState) {
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify({ bullets: s.bullets, rootIds: s.rootIds }));
  } catch {
    /* storage full / unavailable — keep working in-memory */
  }
}

function seed(): OutlineState {
  const doc = loadDoc() ?? fresh();
  const firstId = doc.rootIds[0];
  return {
    ...doc,
    focus: { id: firstId, caret: 'end' },
    selectedId: firstId,
    results: {},
    runErrors: [],
    running: false,
  };
}

let state: OutlineState = seed();
const listeners = new Set<() => void>();

function emit(next: OutlineState) {
  state = next;
  saveDoc(next);
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

/** Ordered list of focus targets — one editor per visible bullet. */
export function focusOrder(s: OutlineState = state): Focus[] {
  return flatten(s).map(({ id }): Focus => ({ id }));
}

/** All bullets as flat run payloads for the server (parentId lets the child
 * auto-include its parent's output; refs are extra @-references). */
export function buildNodePayloads(s: OutlineState = state) {
  const titles = titleMap(s);
  return Object.values(s.bullets).map((b) => ({
    id: b.id,
    text: resolveMentions(b.text, titles),
    parentId: b.parentId,
    refs: b.refs.filter((r) => s.bullets[r]),
    template: b.template,
  }));
}

/**
 * What a mention shows, keyed by id: the bullet's first line with any markdown
 * heading marks dropped, since that line is how people name a bullet.
 */
export function titleMap(s: OutlineState = state): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of Object.values(s.bullets)) out[b.id] = firstLine(b.text);
  return out;
}

/** A bullet's opening line, stripped of heading marks and list bullets. */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+)/, '').trim();
}

/** The bullets a bullet mentions, read straight out of its text. */
function refsFromText(b: Bullet, selfId: string): string[] {
  return mentionIds(b.text).filter((r, i, all) => r !== selfId && all.indexOf(r) === i);
}

/** Keep the caret on `id` (used when reordering). */
function focusFor(_s: OutlineState, id: string): Focus {
  return { id, caret: 'end' };
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
    const idx = order.findIndex((f) => f.id === from.id);
    if (idx === -1) return;
    const target = order[idx + dir];
    if (!target) return;
    actions.setFocus({ ...target, caret: dir === 1 ? 'start' : 'end' });
  },

  setText(id: string, value: string) {
    const b = state.bullets[id];
    if (!b || b.text === value) return;
    const next = clone(state);
    const updated = { ...b, text: value };
    // `@` mentions live in the text as id tokens, so the reference list — and
    // with it the dashed edges — is derived from it rather than tracked apart.
    next.bullets[id] = { ...updated, refs: refsFromText(updated, id) };
    emit(next);
  },

  /** Flip a bullet between a prompt (sent to the LLM) and a template (not). */
  toggleTemplate(id: string) {
    const b = state.bullets[id];
    if (!b) return;
    const next = clone(state);
    next.bullets[id] = { ...b, template: !b.template };
    emit(next);
  },

  /**
   * Move a bullet (with its whole subtree) to a new parent and position —
   * what a drag-and-drop in the outline commits.
   */
  moveTo(id: string, newParentId: string | null, index: number) {
    const b = state.bullets[id];
    if (!b || id === newParentId) return;
    if (newParentId) {
      const desc: string[] = [id];
      collectDescendants(state, id, desc);
      if (desc.includes(newParentId)) return; // can't drop inside itself
    }
    const next = clone(state);
    const { list: oldList, index: oldIndex } = siblingsOf(next, id);
    const sameParent = b.parentId === newParentId;
    setChildren(next, b.parentId, oldList.filter((x) => x !== id));

    const targetList = [...(newParentId ? next.bullets[newParentId].children : next.rootIds)];
    // Removing the bullet first shifts everything after it up by one.
    let at = sameParent && oldIndex < index ? index - 1 : index;
    at = Math.max(0, Math.min(at, targetList.length));
    targetList.splice(at, 0, id);
    setChildren(next, newParentId, targetList);

    next.bullets[id] = { ...next.bullets[id], parentId: newParentId };
    // Dropping into a collapsed parent would hide the bullet you just moved.
    if (newParentId) {
      next.bullets[newParentId] = { ...next.bullets[newParentId], collapsed: false };
    }
    next.focus = { id, caret: 'end' };
    next.selectedId = id;
    emit(next);
  },

  /** Remember where a node was dragged to on the mind map. */
  setPos(id: string, pos: { x: number; y: number }) {
    const b = state.bullets[id];
    if (!b) return;
    const next = clone(state);
    next.bullets[id] = { ...b, pos };
    emit(next);
  },

  toggleCollapse(id: string) {
    const b = state.bullets[id];
    if (!b || b.children.length === 0) return;
    const next = clone(state);
    next.bullets[id] = { ...b, collapsed: !b.collapsed };
    emit(next);
  },

  /** Link two bullets (used by the mind map). The token joins the text, which
   *  is what owns references — the refs list is derived from it. */
  addRef(sourceId: string, targetId: string) {
    const b = state.bullets[sourceId];
    if (!b || !state.bullets[targetId] || sourceId === targetId || b.refs.includes(targetId)) return;
    const next = clone(state);
    const text = b.text.replace(/\s*$/, '') + ' ' + mentionToken(targetId);
    next.bullets[sourceId] = { ...b, text: text.trimStart(), refs: [...b.refs, targetId] };
    emit(next);
  },

  /** Cut a reference: the mention token goes too, since the text owns it. */
  removeRef(sourceId: string, targetId: string) {
    const b = state.bullets[sourceId];
    if (!b || !b.refs.includes(targetId)) return;
    const next = clone(state);
    next.bullets[sourceId] = {
      ...b,
      text: stripMention(b.text, targetId),
      refs: b.refs.filter((r) => r !== targetId),
    };
    emit(next);
  },

  /** Create a new empty child under `parentId`; focus it. */
  addChild(parentId: string): string {
    const parent = state.bullets[parentId];
    if (!parent) return '';
    const next = clone(state);
    const nb = makeBullet({ id: nanoid(), parentId });
    next.bullets[nb.id] = nb;
    next.bullets[parentId] = { ...parent, collapsed: false, children: [...parent.children, nb.id] };
    next.focus = { id: nb.id, caret: 'end' };
    next.selectedId = nb.id;
    emit(next);
    return nb.id;
  },

  /** Workflowy-style move up: swap with previous sibling, or rise above the parent. */
  moveUp(id: string) {
    const b = state.bullets[id];
    if (!b) return;
    const { list, index } = siblingsOf(state, id);
    const next = clone(state);
    if (index > 0) {
      const newList = [...list];
      newList.splice(index, 1);
      newList.splice(index - 1, 0, id);
      setChildren(next, b.parentId, newList);
    } else if (b.parentId) {
      const parent = next.bullets[b.parentId];
      const grandId = parent.parentId;
      setChildren(next, parent.id, parent.children.filter((x) => x !== id));
      const gList = grandId ? next.bullets[grandId].children : next.rootIds;
      const pIndex = gList.indexOf(parent.id);
      const newG = [...gList];
      newG.splice(pIndex, 0, id);
      setChildren(next, grandId, newG);
      next.bullets[id] = { ...next.bullets[id], parentId: grandId };
    } else {
      return; // already the very first top-level bullet
    }
    next.focus = focusFor(state, id);
    emit(next);
  },

  /** Workflowy-style move down: swap with next sibling, or drop below the parent. */
  moveDown(id: string) {
    const b = state.bullets[id];
    if (!b) return;
    const { list, index } = siblingsOf(state, id);
    const next = clone(state);
    if (index < list.length - 1) {
      const newList = [...list];
      newList.splice(index, 1);
      newList.splice(index + 1, 0, id);
      setChildren(next, b.parentId, newList);
    } else if (b.parentId) {
      const parent = next.bullets[b.parentId];
      const grandId = parent.parentId;
      setChildren(next, parent.id, parent.children.filter((x) => x !== id));
      const gList = grandId ? next.bullets[grandId].children : next.rootIds;
      const pIndex = gList.indexOf(parent.id);
      const newG = [...gList];
      newG.splice(pIndex + 1, 0, id);
      setChildren(next, grandId, newG);
      next.bullets[id] = { ...next.bullets[id], parentId: grandId };
    } else {
      return; // already the very last top-level bullet
    }
    next.focus = focusFor(state, id);
    emit(next);
  },

  /** Create a new empty sibling directly after `id`; focus it. */
  addSiblingAfter(id: string): string {
    const next = clone(state);
    const { list, index, parentId } = siblingsOf(next, id);
    const nb = makeBullet({ id: nanoid(), parentId });
    next.bullets[nb.id] = nb;
    const newList = [...list];
    newList.splice(index + 1, 0, nb.id);
    setChildren(next, parentId, newList);
    next.focus = { id: nb.id, caret: 'end' };
    next.selectedId = nb.id;
    emit(next);
    return nb.id;
  },

  /** Make `id` a child of its previous sibling. */
  indent(id: string) {
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
    next.focus = { id, caret: 'end' };
    emit(next);
  },

  /** Move `id` up to become a sibling of its parent, just after it. */
  outdent(id: string) {
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
    next.focus = { id, caret: 'end' };
    emit(next);
  },

  /** Delete an empty bullet (no children); focus the previous target. */
  deleteBullet(id: string) {
    const b = state.bullets[id];
    if (!b || b.children.length > 0) return;
    const order = focusOrder(state);
    const idx = order.findIndex((f) => f.id === id);
    const prev = idx > 0 ? order[idx - 1] : null;
    const next = clone(state);
    const { list } = siblingsOf(next, id);
    setChildren(next, b.parentId, list.filter((x) => x !== id));
    // scrub references to the deleted bullet, tokens included
    for (const other of Object.values(next.bullets)) {
      if (other.refs.includes(id)) {
        next.bullets[other.id] = {
          ...other,
          text: stripMention(other.text, id),
          refs: other.refs.filter((r) => r !== id),
        };
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
