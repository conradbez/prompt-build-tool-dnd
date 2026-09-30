import { useSyncExternalStore } from 'react';
import { nanoid } from 'nanoid';
import type { RunEvent } from './api';
import type { Bullet, BulletKind, FileRef, Focus, OutlineState, FlatBullet, RunFile, TestJudge, TestStatus } from './types';
import { mentionIds, mentionToken, stripMention } from './lib/mentions';
import { RENAMED } from './lib/promptdata';

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
    files: [],
    pos: null,
    kind: 'prompt',
    jsonOutput: false,
    mcpServer: '',
    agentSteps: 0,
    agentBackoff: 0,
    producesFiles: false,
    packages: '',
    judge: 'llm',
    threshold: 0.5,
    ...partial,
  };
}

const DOC_KEY = 'wm.doc.v5';
// Shapes this prototype has outgrown. They are wiped on load, not migrated.
const STALE_KEYS = ['wm.doc.v1', 'wm.doc.v2', 'wm.doc.v3', 'wm.doc.v4'];

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

/** A document on its own: what is saved, exported and pasted around. */
export interface Doc {
  bullets: Record<string, Bullet>;
  rootIds: string[];
}

/**
 * Read a document out of anything — localStorage, a named save, the clipboard —
 * tolerating older and partial shapes. `null` when it is not a document.
 *
 * Every field is taken defensively because the source may be a hand-edited
 * paste, not just this app's own writing.
 */
export function parseDoc(value: unknown): Doc | null {
  try {
    const d = typeof value === 'string' ? JSON.parse(value) : value;
    if (!d || typeof d !== 'object') return null;
    const raw = d as { bullets?: unknown; rootIds?: unknown };
    if (!raw.bullets || typeof raw.bullets !== 'object') return null;
    if (!Array.isArray(raw.rootIds) || raw.rootIds.length === 0) return null;

    const bullets: Record<string, Bullet> = {};
    for (const [id, b] of Object.entries(raw.bullets as Record<string, Record<string, unknown>>)) {
      if (!b || typeof b !== 'object') continue;
      bullets[id] = makeBullet({
        id,
        text: typeof b.text === 'string' ? renameVars(b.text) : '',
        children: Array.isArray(b.children) ? (b.children as string[]) : [],
        parentId: typeof b.parentId === 'string' ? b.parentId : null,
        collapsed: !!b.collapsed,
        refs: Array.isArray(b.refs) ? (b.refs as string[]) : [],
        files: Array.isArray(b.files) ? (b.files as FileRef[]) : [],
        pos: isPos(b.pos) ? b.pos : null,
        kind: isKind(b.kind) ? b.kind : 'prompt',
        jsonOutput: !!b.jsonOutput,
        mcpServer: typeof b.mcpServer === 'string' ? b.mcpServer : '',
        agentSteps: typeof b.agentSteps === 'number' && b.agentSteps > 0 ? Math.floor(b.agentSteps) : 0,
        agentBackoff: typeof b.agentBackoff === 'number' && b.agentBackoff > 0 ? b.agentBackoff : 0,
        producesFiles: !!b.producesFiles,
        packages: typeof b.packages === 'string' ? b.packages : '',
        judge: b.judge === 'classifier' ? 'classifier' : 'llm',
        threshold: typeof b.threshold === 'number' ? clampThreshold(b.threshold) : 0.5,
      });
    }
    // A child naming a parent that did not come with it would strand it, so
    // both directions are filtered down to bullets that actually arrived.
    for (const b of Object.values(bullets)) {
      b.children = b.children.filter((c) => bullets[c]);
      if (b.parentId && !bullets[b.parentId]) b.parentId = null;
      b.refs = b.refs.filter((r) => bullets[r]);
    }
    const rootIds = (raw.rootIds as string[]).filter((id) => bullets[id]);
    return rootIds.length ? { bullets, rootIds } : null;
  } catch {
    return null;
  }
}

/** A classifier pass mark, kept to what pbt accepts. */
export function clampThreshold(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

/**
 * Carry a bullet's `@name`s across a variable rename.
 *
 * A one-time rewrite, not a migration: the old names resolve to nothing now, so
 * a bullet still carrying one would quietly go back to being prose — the kind
 * of breakage you find out about from a prompt that read differently than you
 * thought it did.
 */
function renameVars(text: string): string {
  return Object.entries(RENAMED).reduce(
    (out, [from, to]) => out.replace(new RegExp(`@${from}\\b`, 'g'), `@${to}`),
    text,
  );
}

/** Load the live document from localStorage; null if none or invalid. */
function loadDoc(): Doc | null {
  try {
    for (const k of STALE_KEYS) localStorage.removeItem(k);
    return parseDoc(localStorage.getItem(DOC_KEY));
  } catch {
    return null;
  }
}

function isKind(v: unknown): v is BulletKind {
  return v === 'prompt' || v === 'template' || v === 'python' || v === 'agent' || v === 'test';
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
    blockSel: null,
    results: {},
    tests: {},
    files: {},
    prompts: {},
    runErrors: [],
    running: false,
    runStatus: {},
    runFailures: {},
    runLog: [],
    progressOpen: false,
    openResultId: null,
    openSettingsId: null,
  };
}

let state: OutlineState = seed();

// When the current run began, and what its bullets are called — kept out of
// the state because nothing renders them directly; the log lines carry both.
let runStartedAt = 0;
let runTitles: Record<string, string> = {};
const listeners = new Set<() => void>();

function emit(next: OutlineState) {
  state = next;
  saveDoc(next);
  listeners.forEach((l) => l());
}

/** Be told when anything in the document changes. Returns the unsubscribe. */
export function subscribeStore(l: () => void): () => void {
  return subscribe(l);
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
  return Object.values(s.bullets).map((b) => ({
    id: b.id,
    // Raw, mention tokens and all: the server puts each referenced bullet's
    // output where its mention stands, so the position has to survive the trip.
    text: b.text,
    files: b.files,
    parentId: b.parentId,
    refs: b.refs.filter((r) => s.bullets[r]),
    kind: b.kind,
    jsonOutput: b.jsonOutput,
    mcpServer: b.mcpServer,
    agentSteps: b.agentSteps,
    agentBackoff: b.agentBackoff,
    producesFiles: b.producesFiles,
    packages: b.packages,
    judge: b.judge,
    threshold: b.threshold,
  }));
}

/** The live document, as it is saved and copied — pretty-printed for a person. */
export function docJson(s: OutlineState = state): string {
  return JSON.stringify({ bullets: s.bullets, rootIds: s.rootIds }, null, 2);
}

/** The live document, for handing to a named save. */
export function currentDoc(s: OutlineState = state): Doc {
  return { bullets: s.bullets, rootIds: s.rootIds };
}

/**
 * What a mention shows, keyed by id: the bullet's first line with any markdown
 * heading marks dropped, since that line is how people name a bullet.
 */
export function titleMap(s: OutlineState = state): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of Object.values(s.bullets)) {
    // A python bullet has no text to take a name from, but it is still a
    // legitimate `@` target — the thing its script printed. Name it for what
    // it is rather than letting mentions to it read "@Untitled".
    out[b.id] = b.kind === 'python' ? 'Python' : firstLine(b.text);
  }
  return out;
}

/** A bullet's opening line, stripped of heading marks and list bullets. */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+)/, '').trim();
}

/**
 * Whether `parentId` may take `movingId` as a child.
 *
 * A python bullet runs *one* program, and its child's output is that program.
 * Two children would mean two scripts concatenated into one file, which is
 * nobody's intent — so it holds exactly one child, and every path that could
 * give it a second is turned away here rather than in six separate places.
 * Passing `movingId` lets a bullet already sitting there be reordered.
 */
export function canTakeChild(
  s: OutlineState,
  parentId: string | null,
  movingId?: string,
): boolean {
  if (!parentId) return true; // top level is unbounded
  const parent = s.bullets[parentId];
  if (!parent || parent.kind !== 'python') return true;
  return parent.children.filter((c) => c !== movingId).length === 0;
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

/** The bullets a block selection covers, in reading order. */
export function blockIds(s: OutlineState = state): string[] {
  if (!s.blockSel) return [];
  const ids = flatten(s).map((r) => r.id);
  const a = ids.indexOf(s.blockSel.anchor);
  const h = ids.indexOf(s.blockSel.head);
  if (a === -1 || h === -1) return [];
  return ids.slice(Math.min(a, h), Math.max(a, h) + 1);
}

/** `ids` minus any whose ancestor is also in it — the roots of the block. */
function topmost(s: OutlineState, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let p = s.bullets[id]?.parentId; p; p = s.bullets[p]?.parentId) if (set.has(p)) return false;
    return !!s.bullets[id];
  });
}

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
    if (focus) {
      next.selectedId = focus.id;
      next.blockSel = null;
    }
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

  /** Make a bullet a prompt, a template, python or an agent — see `BulletKind`. */
  setKind(id: string, kind: BulletKind) {
    const b = state.bullets[id];
    if (!b || b.kind === kind) return;
    const next = clone(state);
    // A python bullet runs its children's code and never its own text, so any
    // text it is carrying is dead weight the moment it becomes one. Dropping
    // it here is what keeps the row honest: what you see is what runs.
    next.bullets[id] = kind === 'python' ? { ...b, kind, text: '', refs: [] } : { ...b, kind };
    emit(next);
  },

  /**
   * Replace the whole document — a named save being loaded, or a paste.
   *
   * Everything derived from a run is dropped with it: results and prompts
   * belong to the bullets that produced them, and keeping them against a
   * different document would attach one map's answers to another's bullets.
   */
  replaceDoc(doc: Doc) {
    const firstId = doc.rootIds[0];
    emit({
      ...state,
      bullets: doc.bullets,
      rootIds: doc.rootIds,
      focus: { id: firstId, caret: 'end' },
      selectedId: firstId,
      blockSel: null,
      results: {},
      tests: {},
      files: {},
      prompts: {},
      runErrors: [],
      runStatus: {},
      runFailures: {},
      runLog: [],
      openResultId: null,
      openSettingsId: null,
    });
  },

  /** Set the MCP server an agent bullet starts — see `Bullet.mcpServer`. */
  // Not trimmed: it is edited as you type, and trimming would eat the space
  // between a command and its arguments. The server normalises whitespace.
  setMcpServer(id: string, command: string) {
    const b = state.bullets[id];
    if (!b || b.mcpServer === command) return;
    const next = clone(state);
    next.bullets[id] = { ...b, mcpServer: command };
    emit(next);
  },

  /** Set an agent bullet's step limit — see `Bullet.agentSteps`. 0 clears it. */
  setAgentSteps(id: string, steps: number) {
    const b = state.bullets[id];
    const value = Math.max(0, Math.floor(steps) || 0);
    if (!b || b.agentSteps === value) return;
    const next = clone(state);
    next.bullets[id] = { ...b, agentSteps: value };
    emit(next);
  },

  /** Set an agent bullet's back-off in seconds — see `Bullet.agentBackoff`. 0 clears it. */
  setAgentBackoff(id: string, seconds: number) {
    const b = state.bullets[id];
    const value = Math.max(0, seconds || 0);
    if (!b || b.agentBackoff === value) return;
    const next = clone(state);
    next.bullets[id] = { ...b, agentBackoff: value };
    emit(next);
  },

  /** Whether an agent bullet hands on files — see `Bullet.producesFiles`. */
  setProducesFiles(id: string, on: boolean) {
    const b = state.bullets[id];
    if (!b || b.producesFiles === on) return;
    const next = clone(state);
    next.bullets[id] = { ...b, producesFiles: on };
    emit(next);
  },

  /** Choose who judges a test bullet — see `TestJudge`. */
  setJudge(id: string, judge: TestJudge) {
    const b = state.bullets[id];
    if (!b || b.judge === judge) return;
    const next = clone(state);
    next.bullets[id] = { ...b, judge };
    emit(next);
  },

  /** Set a classifier-judged test's pass mark — see `Bullet.threshold`. */
  setThreshold(id: string, threshold: number) {
    const b = state.bullets[id];
    const t = clampThreshold(threshold);
    if (!b || b.threshold === t) return;
    const next = clone(state);
    next.bullets[id] = { ...b, threshold: t };
    emit(next);
  },

  /** Set a python bullet's extra sandbox packages — see `Bullet.packages`. */
  setPackages(id: string, packages: string) {
    const b = state.bullets[id];
    if (!b || b.packages === packages) return;
    const next = clone(state);
    next.bullets[id] = { ...b, packages };
    emit(next);
  },

  /** Turn JSON enforcement on or off for one bullet — see `Bullet.jsonOutput`. */
  setJsonOutput(id: string, on: boolean) {
    const b = state.bullets[id];
    if (!b || b.jsonOutput === on) return;
    const next = clone(state);
    next.bullets[id] = { ...b, jsonOutput: on };
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
    if (!canTakeChild(state, newParentId, id)) return;
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

  /** Attach an uploaded file to a bullet. */
  attachFile(id: string, file: FileRef) {
    const b = state.bullets[id];
    if (!b || b.files.some((f) => f.key === file.key)) return;
    const next = clone(state);
    next.bullets[id] = { ...b, files: [...b.files, file] };
    emit(next);
  },

  /** Drop an attachment from a bullet (the object itself is deleted by the
   *  caller, which owns the server round-trip). */
  detachFile(id: string, key: string) {
    const b = state.bullets[id];
    if (!b) return;
    const next = clone(state);
    next.bullets[id] = { ...b, files: b.files.filter((f) => f.key !== key) };
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
    if (!canTakeChild(state, parentId)) return '';
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
      if (!canTakeChild(state, grandId, id)) return;
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
      if (!canTakeChild(state, grandId, id)) return;
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

  /**
   * Create a new empty sibling directly *before* `id`, leaving the caret where
   * it was — in `id`, which has moved down a line.
   *
   * This is Enter pressed at the very start of a bullet: the intent is to make
   * room above what you are looking at, not to leave it and start something
   * else, so the caret stays put instead of following the new bullet the way
   * `addSiblingAfter` makes it follow.
   *
   * Focus is re-asserted on `id` rather than left alone. Leaving it alone
   * *looks* like it should work — the row keeps its element and the store's
   * focus never changed — but a row inserted above this one moves it in the
   * DOM, and the caret does not reliably survive that. Saying where the caret
   * goes is the only way to know where it went.
   */
  addSiblingBefore(id: string): string {
    if (!canTakeChild(state, state.bullets[id]?.parentId ?? null)) return '';
    const next = clone(state);
    const { list, index, parentId } = siblingsOf(next, id);
    const nb = makeBullet({ id: nanoid(), parentId });
    next.bullets[nb.id] = nb;
    const newList = [...list];
    newList.splice(index, 0, nb.id);
    setChildren(next, parentId, newList);
    next.focus = { id, caret: 'start' };
    next.selectedId = id;
    emit(next);
    return nb.id;
  },

  /** Create a new empty sibling directly after `id`; focus it. */
  addSiblingAfter(id: string): string {
    if (!canTakeChild(state, state.bullets[id]?.parentId ?? null)) return '';
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
    if (!canTakeChild(state, list[index - 1])) return;
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

  /** Start, extend or clear the multi-row selection. Leaves the caret alone. */
  setBlockSel(blockSel: OutlineState['blockSel']) {
    if (state.blockSel?.anchor === blockSel?.anchor && state.blockSel?.head === blockSel?.head) return;
    emit({ ...state, blockSel });
  },

  /** Delete several bullets, each with everything under it. */
  deleteBullets(ids: string[]) {
    const tops = topmost(state, ids);
    if (tops.length === 0) return;
    const order = focusOrder(state);
    const firstIdx = order.findIndex((f) => f.id === tops[0]);
    const next = clone(state);
    const gone = new Set<string>();
    for (const id of tops) {
      gone.add(id);
      const acc: string[] = [];
      collectDescendants(next, id, acc);
      acc.forEach((d) => gone.add(d));
    }
    for (const id of tops) {
      const b = next.bullets[id];
      const { list } = siblingsOf(next, id);
      setChildren(next, b.parentId, list.filter((x) => x !== id));
    }
    for (const id of gone) delete next.bullets[id];
    // scrub references to anything deleted, tokens included
    for (const other of Object.values(next.bullets)) {
      const dead = other.refs.filter((r) => gone.has(r));
      if (dead.length === 0) continue;
      next.bullets[other.id] = {
        ...other,
        text: dead.reduce((t, r) => stripMention(t, r), other.text),
        refs: other.refs.filter((r) => !gone.has(r)),
      };
    }
    // Never leave an empty outline — there'd be nowhere to type.
    if (next.rootIds.length === 0) {
      const nb = makeBullet({ id: nanoid(), parentId: null });
      next.bullets[nb.id] = nb;
      next.rootIds = [nb.id];
    }
    const prev = order.slice(0, Math.max(firstIdx, 0)).reverse().find((f) => next.bullets[f.id]);
    const targetId = prev?.id ?? next.rootIds[0];
    next.focus = { id: targetId, caret: 'end' };
    next.selectedId = targetId;
    next.blockSel = null;
    emit(next);
  },

  /** Indent (+1) or outdent (-1) several bullets as one block. */
  shiftBullets(ids: string[], dir: -1 | 1) {
    const tops = topmost(state, ids);
    // Outdenting drops each one just after its parent, so go bottom-up to
    // keep them in order; indenting goes top-down for the same reason.
    for (const id of dir === 1 ? tops : [...tops].reverse()) {
      if (dir === 1) actions.indent(id);
      else actions.outdent(id);
    }
    // indent/outdent move the caret to the bullet; a block keeps no caret.
    emit({ ...state, focus: null });
  },

  setRunning(running: boolean) {
    if (running) runStartedAt = 0;
    // A new run clears the last one's log, so a run that fails before it
    // starts doesn't leave its error under the previous run's lines.
    emit({ ...state, running, ...(running ? { runErrors: [], runLog: [] } : {}) });
  },

  /**
   * Fold one progress event into the run. An answer lands on its bullet the
   * moment it finishes, so a long run fills in as it goes rather than all at
   * the end; the `final` event then settles everything (see `setRunResult`).
   */
  runEvent(event: RunEvent) {
    const at = runStartedAt ? Date.now() - runStartedAt : 0;
    const title = (id: string) => runTitles[id] || 'a bullet';
    if (event.type === 'plan') {
      runStartedAt = Date.now();
      runTitles = Object.fromEntries(event.models.map((m) => [m.id, m.title]));
      const n = event.models.length;
      emit({
        ...state,
        runStatus: Object.fromEntries(event.models.map((m) => [m.id, 'queued' as const])),
        runFailures: {},
        runLog: [{ at: 0, kind: 'plan', title: `Running ${n} bullet${n === 1 ? '' : 's'}` }],
      });
    } else if (event.type === 'start') {
      emit({
        ...state,
        runStatus: { ...state.runStatus, [event.id]: 'running' },
        runLog: [...state.runLog, { at, kind: 'start', id: event.id, title: title(event.id) }],
      });
    } else if (event.type === 'log') {
      emit({
        ...state,
        runLog: [...state.runLog, { at, kind: 'log', id: event.id, title: event.line }],
      });
    } else if (event.type === 'done') {
      const next: OutlineState = {
        ...state,
        runStatus: { ...state.runStatus, [event.id]: event.status },
        runLog: [
          ...state.runLog,
          {
            at,
            kind: event.status,
            id: event.id,
            title: title(event.id),
            detail:
              event.status === 'success'
                ? `${(event.ms / 1000).toFixed(1)}s${event.cached ? ' · cached' : ''}`
                : event.error,
          },
        ],
      };
      if (event.status !== 'success') {
        next.runFailures = { ...state.runFailures, [event.id]: event.error };
      }
      if (event.output !== undefined) next.results = { ...state.results, [event.id]: event.output };
      if (event.prompt !== undefined) next.prompts = { ...state.prompts, [event.id]: event.prompt };
      if (event.test) next.tests = { ...state.tests, [event.id]: event.test };
      if (event.status === 'success') {
        // Its files are replaced along with its answer, or dropped if it made none this time.
        const { [event.id]: _old, ...rest } = state.files;
        next.files = event.files?.length ? { ...rest, [event.id]: event.files } : rest;
      }
      emit(next);
    } else if (event.type === 'final' && !event.needsKey) {
      const failed = Object.values(state.runStatus).filter((s) => s === 'error').length;
      const secs = ((Date.now() - (runStartedAt || Date.now())) / 1000).toFixed(1);
      emit({
        ...state,
        runLog: [
          ...state.runLog,
          {
            at,
            kind: 'end',
            title: failed ? `Finished with ${failed} error${failed === 1 ? '' : 's'}` : 'Finished',
            detail: `${secs}s`,
          },
        ],
      });
    }
  },

  openProgress(open: boolean) {
    if (state.progressOpen === open) return;
    emit({ ...state, progressOpen: open });
  },

  /** Open the node modal for one bullet with its settings expanded. */
  openSettings(id: string | null) {
    if (state.openSettingsId === id && state.openResultId === id) return;
    emit({ ...state, openSettingsId: id, openResultId: id });
  },

  /** Open (or close, with null) the node modal for one bullet. */
  openResult(id: string | null) {
    if (state.openResultId === id && state.openSettingsId === null) return;
    emit({ ...state, openResultId: id, openSettingsId: null });
  },

  setRunResult(
    outputs: Record<string, string>,
    errors: string[],
    prompts: Record<string, string> = {},
    tests: Record<string, TestStatus> = {},
    files: Record<string, RunFile[]> = {},
  ) {
    // A bullet still queued or running when the run ended never finished —
    // the stream broke off — so it has no status rather than a stuck spinner.
    const runStatus = Object.fromEntries(
      Object.entries(state.runStatus).filter(([, s]) => s !== 'queued' && s !== 'running'),
    );
    // Errors about the run as a whole (the server was unreachable, nothing to
    // run) have no bullet to land on, so they go in the log. When bullets
    // failed, the errors are theirs and the log already carries them.
    const bulletFailed = state.runLog.some((l) => l.kind === 'error' || l.kind === 'skipped');
    const at = runStartedAt ? Date.now() - runStartedAt : 0;
    const runLog = bulletFailed
      ? state.runLog
      : [...state.runLog, ...errors.map((e) => ({ at, kind: 'error' as const, title: 'Run failed', detail: e }))];
    emit({ ...state, results: outputs, prompts, tests, files, runErrors: errors, running: false, runStatus, runLog });
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
    if (!canTakeChild(state, newParentId, id)) return;
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
