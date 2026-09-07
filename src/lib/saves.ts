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
 */

import { useSyncExternalStore } from 'react';

import { currentDoc, getState, parseDoc, subscribeStore, type Doc } from '../store';

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

/** Saved names, the reserved one last — it is a safety net, not a document. */
export function listSaves(): string[] {
  const names = Object.keys(readAll());
  const rest = names.filter((n) => n !== BEFORE_LOAD).sort((a, b) => a.localeCompare(b));
  return names.includes(BEFORE_LOAD) ? [...rest, BEFORE_LOAD] : rest;
}

export function readSave(name: string): Doc | null {
  return readAll()[name] ?? null;
}

export function hasSave(name: string): boolean {
  return name in readAll();
}

/** Write `doc` under `name`. False when storage refused it. */
export function writeSave(name: string, doc: Doc): boolean {
  const saves = readAll();
  saves[name] = doc;
  return writeAll(saves);
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
 * Keep the open save in step with the document, for the life of the page.
 *
 * Coalesced onto a timer rather than written per keystroke: every character
 * typed is a store change, and each one would otherwise re-serialise the whole
 * document into localStorage.
 */
export function startAutoSave(delay = 600): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  subscribeStore(() => {
    if (!openName) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (openName) writeSave(openName, currentDoc(getState()));
    }, delay);
  });
}
