/**
 * Named documents, kept in this browser.
 *
 * The app has one *live* document (`wm.doc.v5`, written on every edit). A save
 * is a copy of it under a name; a load puts a copy back. They are deliberately
 * separate keys: editing after a load must not touch what you saved, and saving
 * must not disturb what you are editing.
 *
 * Loading replaces everything on screen, which is the one destructive thing in
 * here — so the outgoing document is always stashed in `BEFORE_LOAD` first.
 * That is one step back, not a history, and it costs nothing to keep.
 *
 * Signed in (see `lib/account`), the saves are the server's instead: the names
 * come from it, every write goes to it, and a page load opens the map saved
 * last. Signed out, nothing changes from the above.
 */

import { useSyncExternalStore } from 'react';

import { actions, currentDoc, getState, parseDoc, subscribeStore, type Doc } from '../store';
import { MapConflict, fetchMaps, getAccount, putMap, subscribeAccount } from './account';

const STORAGE_KEY = 'wm.saves';

/** Which save the document on screen *is*, so edits can go back into it. */
const CURRENT_KEY = 'wm.saves.current';

/** Where the document that a load displaced goes. Reserved, and reused. */
export const BEFORE_LOAD = 'Before last load';

export const MAX_NAME = 60;

type Saves = Record<string, Doc>;

function readAll(): Saves {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Saves = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const doc = parseDoc(value);
      if (doc) out[name] = doc;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(saves: Saves): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saves));
    return true;
  } catch {
    // Out of quota, or storage blocked. The caller says so rather than
    // reporting a save that did not happen.
    return false;
  }
}

// ---------------------------------------------------------------------------
// On the server, when signed in
// ---------------------------------------------------------------------------

/**
 * The server's saves as this page knows them: every name, and the documents
 * fetched or written so far. Null when signed out, or not yet fetched.
 */
let cloud: { names: Set<string>; docs: Record<string, Doc> } | null = null;

/** The map signed in to the server first gets, when there are none yet. */
export const FIRST_MAP = 'My map';

/**
 * Fetch the server's saves and open the one saved last — or, on a first
 * sign-in, put the map on screen there as `FIRST_MAP`. Call at startup and
 * after signing in; does nothing when signed out.
 */
export async function syncFromServer(): Promise<void> {
  if (!getAccount()) return;
  const list = await fetchMaps();
  cloud = { names: new Set(list.maps.map((m) => m.name)), docs: {} };
  const doc = list.current && parseDoc(list.current.doc);
  if (list.current && doc) {
    cloud.docs[list.current.name] = doc;
    revs[list.current.name] = list.current.rev;
    conflicted.delete(list.current.name);
    actions.replaceDoc(doc);
    markSaved();
    setOpenSave(list.current.name);
  } else {
    // A first sign-in brings this browser's saves along, and the map on screen.
    const open = openName;
    for (const [name, saved] of Object.entries(readAll())) writeSave(name, saved);
    const name = open ?? FIRST_MAP;
    writeSave(name, currentDoc(getState()));
    setOpenSave(name);
  }
}

// Signing out leaves the server's saves behind, and the map open among them.
subscribeAccount(() => {
  if (getAccount() || !cloud) return;
  cloud = null;
  setOpenSave(null);
});

function sorted(names: string[]): string[] {
  const rest = names.filter((n) => n !== BEFORE_LOAD).sort((a, b) => a.localeCompare(b));
  return names.includes(BEFORE_LOAD) ? [...rest, BEFORE_LOAD] : rest;
}

/** Saved names, the reserved one last — it is a safety net, not a document. */
export function listSaves(): string[] {
  if (cloud) return sorted([...cloud.names]);
  const names = Object.keys(readAll());
  const rest = names.filter((n) => n !== BEFORE_LOAD).sort((a, b) => a.localeCompare(b));
  return names.includes(BEFORE_LOAD) ? [...rest, BEFORE_LOAD] : rest;
}

/** A save's document, fetched from the server when signed in. */
export async function loadSave(name: string): Promise<Doc | null> {
  if (!cloud) return readAll()[name] ?? null;
  const list = await fetchMaps(name);
  const doc = list.current && parseDoc(list.current.doc);
  if (doc && list.current) {
    cloud.docs[name] = doc;
    revs[name] = list.current.rev;
    conflicted.delete(name);
  }
  return doc || null;
}

export function hasSave(name: string): boolean {
  if (cloud) return cloud.names.has(name);
  return name in readAll();
}

/**
 * Write `doc` under `name`, overwriting whatever is there — a save someone
 * asked for. False when storage refused it. On the server the write is queued
 * rather than waited for; its progress is `useSaveStatus`.
 */
export function writeSave(name: string, doc: Doc): boolean {
  return store(name, doc, true);
}

/**
 * `writeSave`, except that on the server *force* false is an autosave: based on
 * the revision this page last saw, and refused if the map was saved elsewhere
 * since rather than overwriting it.
 */
function store(name: string, doc: Doc, force: boolean): boolean {
  if (cloud) {
    cloud.names.add(name);
    cloud.docs[name] = doc;
    queue(name, doc, force);
    return true;
  }
  const saves = readAll();
  saves[name] = doc;
  const ok = writeAll(saves);
  report(name, ok ? 'saved' : 'error', ok ? '' : 'This browser refused the save — storage may be full.');
  return ok;
}

// ---------------------------------------------------------------------------
// Sending to the server
// ---------------------------------------------------------------------------

/**
 * Each map's revision as this page last saw it, sent with every autosave so
 * the server can refuse one based on a copy that is out of date.
 */
const revs: Record<string, number> = {};

/**
 * The newest document waiting to go, per map. One request per map is in flight
 * at a time, and only the newest edit made meanwhile follows it: requests sent
 * side by side could land in either order and leave the older document saved.
 */
const waiting: Record<string, { doc: Doc; force: boolean }> = {};
const sending = new Set<string>();

/** Maps saved elsewhere since this page saw them; nothing is sent until resolved. */
const conflicted = new Set<string>();

/** A failed save is retried after these waits, the last one repeating. */
const RETRY_MS = [2000, 5000, 15000, 30000];
const retrying: Record<string, ReturnType<typeof setTimeout>> = {};
const failures: Record<string, number> = {};

function queue(name: string, doc: Doc, force: boolean) {
  waiting[name] = { doc, force: force || !!waiting[name]?.force };
  if (force) {
    // A save someone asked for goes now, past a conflict or a pending retry.
    conflicted.delete(name);
    clearTimeout(retrying[name]);
    delete retrying[name];
  }
  void pump(name);
}

async function pump(name: string): Promise<void> {
  const job = waiting[name];
  if (!job || sending.has(name) || retrying[name] || conflicted.has(name)) return;
  delete waiting[name];
  sending.add(name);
  report(name, 'saving');
  try {
    revs[name] = await putMap(name, job.doc, job.force ? undefined : revs[name]);
    failures[name] = 0;
    if (!waiting[name]) report(name, 'saved');
  } catch (e) {
    if (e instanceof MapConflict) {
      // What is on screen stays on screen; `keepMine` or `takeTheirs` decides.
      conflicted.add(name);
      delete waiting[name];
      report(name, 'conflict', e.message);
    } else {
      // An edit made since is newer than this one, and goes in its place.
      const newer = waiting[name];
      waiting[name] = newer ? { ...newer, force: newer.force || job.force } : job;
      const n = (failures[name] = (failures[name] ?? 0) + 1);
      const wait = RETRY_MS[Math.min(n, RETRY_MS.length) - 1];
      retrying[name] = setTimeout(() => {
        delete retrying[name];
        void pump(name);
      }, wait);
      report(name, 'error', `${(e as Error).message} Retrying in ${wait / 1000}s.`);
    }
  } finally {
    sending.delete(name);
  }
  void pump(name);
}

// ---------------------------------------------------------------------------
// Save status
// ---------------------------------------------------------------------------

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/** How the open map's last save went — shown so a failed one is not silent. */
export interface SaveStatus {
  state: SaveState;
  name: string | null;
  message: string;
}

let status: SaveStatus = { state: 'idle', name: null, message: '' };
const statusListeners = new Set<() => void>();

function report(name: string, state: SaveState, message = '') {
  // Only the open map's saves are this page's to show; one into
  // `BEFORE_LOAD`, say, is not what anyone is watching.
  if (name !== openName) {
    if (state === 'error' || state === 'conflict') console.warn(`Saving “${name}”: ${message}`);
    return;
  }
  status = { state, name, message };
  statusListeners.forEach((l) => l());
}

function getStatus(): SaveStatus {
  return status;
}

export function useSaveStatus(): SaveStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    getStatus,
    getStatus,
  );
}

/** Settle a conflict by saving what is on screen over the other copy. */
export function keepMine(): void {
  if (openName) store(openName, currentDoc(getState()), true);
  markSaved();
}

/** Settle a conflict by putting the other copy on screen. */
export async function takeTheirs(): Promise<void> {
  const name = openName;
  if (!name) return;
  const doc = await loadSave(name);
  if (!doc) throw new Error(`“${name}” could not be read.`);
  actions.replaceDoc(doc);
  markSaved();
  report(name, 'saved');
}

export function deleteSave(name: string): boolean {
  const saves = readAll();
  delete saves[name];
  return writeAll(saves);
}

/** Trimmed, and short enough to read back in a dropdown. */
export function cleanName(name: string): string {
  return name.trim().slice(0, MAX_NAME);
}


// ---------------------------------------------------------------------------
// The open document
// ---------------------------------------------------------------------------

/**
 * Saving or loading a name makes that save *the document you are working in*,
 * and from then on edits go back into it — a save that goes stale the moment
 * you carry on typing is a save you cannot trust.
 *
 * Nothing is open until you save or load one: the live document persists on its
 * own (`wm.doc.v5`), and quietly adopting a name would mean the dropdown chose
 * what your edits overwrite, which is not what picking from a list means.
 */
let openName: string | null = null;
const openListeners = new Set<() => void>();

try {
  const saved = localStorage.getItem(CURRENT_KEY);
  if (saved && saved in readAll()) openName = saved;
} catch {
  /* storage blocked — nothing is open, which is the safe end of the guess */
}

export function getOpenSave(): string | null {
  return openName;
}

export function setOpenSave(name: string | null): void {
  openName = name;
  status = name && conflicted.has(name)
    ? { state: 'conflict', name, message: `“${name}” was saved somewhere else.` }
    : { state: 'idle', name, message: '' };
  statusListeners.forEach((l) => l());
  try {
    if (name) localStorage.setItem(CURRENT_KEY, name);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* nothing to do: the name is still held for this page load */
  }
  openListeners.forEach((l) => l());
}

export function useOpenSave(): string | null {
  return useSyncExternalStore(
    (l) => {
      openListeners.add(l);
      return () => openListeners.delete(l);
    },
    getOpenSave,
    getOpenSave,
  );
}

/**
 * The document last handed to a save, by identity: the store replaces what it
 * changes, so the same objects mean nothing in the document has changed — a
 * run's progress, a selection — and there is nothing to send.
 */
let saved: { bullets: unknown; rootIds: unknown } = { bullets: null, rootIds: null };

function markSaved() {
  const s = getState();
  saved = { bullets: s.bullets, rootIds: s.rootIds };
}

function dirty(): boolean {
  const s = getState();
  return s.bullets !== saved.bullets || s.rootIds !== saved.rootIds;
}

let autoTimer: ReturnType<typeof setTimeout> | undefined;

/** Save the open map now if an edit is waiting on the autosave timer. */
export function flushAutoSave() {
  clearTimeout(autoTimer);
  autoTimer = undefined;
  if (openName && dirty()) {
    markSaved();
    store(openName, currentDoc(getState()), false);
  }
}

/**
 * Keep the open save in step with the document, for the life of the page.
 *
 * Coalesced onto a timer rather than written per keystroke: every character
 * typed is a store change, and each one would otherwise re-serialise the whole
 * document. Whatever is still waiting when the page closes is sent then.
 */
export function startAutoSave(delay = 600): void {
  markSaved();
  subscribeStore(() => {
    if (!openName || !dirty()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(flushAutoSave, delay);
  });
  window.addEventListener('pagehide', () => {
    const name = openName;
    if (!name) return;
    if (!cloud) return flushAutoSave(); // localStorage writes are synchronous
    clearTimeout(autoTimer);
    const job = dirty() ? { doc: currentDoc(getState()), force: false } : waiting[name];
    if (!job || conflicted.has(name)) return;
    // The queue cannot run once the page is gone, so this goes on its own. If
    // a save is mid-flight its new revision is not known yet: send without one.
    const rev = job.force || sending.has(name) ? undefined : revs[name];
    void putMap(name, job.doc, rev, true).catch(() => {});
  });
}

/** `Untitled`, else `Untitled 2`, `Untitled 3`… — the first not taken. */
function untitled(): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'Untitled' : `Untitled ${n}`;
    if (!hasSave(name)) return name;
  }
}

/**
 * Start a blank map as a new save of its own, and open it. What was on screen
 * is saved first: into its own save if one is open, else as `BEFORE_LOAD`.
 * Returns the new map's name.
 */
export function startNewMap(): string {
  flushAutoSave();
  if (!openName) writeSave(BEFORE_LOAD, currentDoc(getState()));
  // Closed first, so the blank document is never autosaved into the old map.
  setOpenSave(null);
  actions.newDoc();
  const name = untitled();
  writeSave(name, currentDoc(getState()));
  markSaved();
  setOpenSave(name);
  return name;
}
