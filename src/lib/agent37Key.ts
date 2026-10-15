/**
 * The user's own Agent37 key (Settings), kept in this browser.
 *
 * Blank runs preserve-disk agents on the server's shared Agent37 machine; set,
 * on a machine in the user's own workspace. A store rather than Toolbar state
 * so a bullet's settings can warn about the shared machine the moment the key
 * is cleared or typed.
 */
import { useSyncExternalStore } from 'react';

const STORAGE = 'wm.agent37Key';

let key: string = (() => {
  try {
    return localStorage.getItem(STORAGE) || '';
  } catch {
    return '';
  }
})();
const listeners = new Set<() => void>();

export function getAgent37Key(): string {
  return key;
}

export function setAgent37Key(v: string): void {
  key = v;
  try {
    localStorage.setItem(STORAGE, v);
  } catch {
    // Still set for this page; it just will not outlive a reload.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAgent37Key(): string {
  return useSyncExternalStore(subscribe, getAgent37Key);
}
