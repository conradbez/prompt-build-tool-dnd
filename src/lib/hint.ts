import { useEffect, useState } from 'react';

/**
 * "You could have pressed …" — a quiet toast shown after the mouse does
 * something a key also does. Only on a machine with a keyboard: a touch screen
 * has no shortcuts to learn.
 */
export interface Hint {
  keys: string;
  desc: string;
  /** New per showing, so a repeat replays the toast's fade. */
  n: number;
}

const HAS_KEYBOARD =
  typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** How long a hint stays up. */
const SHOW_MS = 2600;

let current: Hint | null = null;
let shown = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(h: Hint | null) => void>();

function set(h: Hint | null) {
  current = h;
  listeners.forEach((l) => l(h));
}

export function showHint(keys: string, desc: string) {
  if (!HAS_KEYBOARD) return;
  clearTimeout(timer);
  set({ keys, desc, n: ++shown });
  timer = setTimeout(() => set(null), SHOW_MS);
}

export function useHint(): Hint | null {
  const [h, setH] = useState(current);
  useEffect(() => {
    listeners.add(setH);
    return () => {
      listeners.delete(setH);
    };
  }, []);
  return h;
}
