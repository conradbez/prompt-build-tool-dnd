/**
 * Run variables — pbt's `promptdata`.
 *
 * A variable is a name and a value, typed into Settings and written into a
 * bullet as `@name`. At run time the server turns each `@name` into
 * `{{ promptdata("name") }}` and hands the values to pbt, so one value can
 * appear in many bullets and change in one place.
 *
 * Unlike an `@` mention of a bullet — stored as an unchanging id — a variable
 * is referenced **by its name**, because the name is the thing a person wrote
 * and the thing they read back. Renaming a variable in Settings therefore does
 * not chase the `@name`s already typed into bullets: those simply stop being
 * variables and go back to being plain text.
 *
 * The rows live here rather than in the outline store: they are not part of the
 * document, and three unrelated places need them — Settings (edits them), the
 * bullet editor (colours and completes them) and the toolbar (sends them).
 */

import { useSyncExternalStore } from 'react';

export interface PromptVar {
  name: string;
  value: string;
}

/** What a name may contain — it becomes a Jinja identifier on the server. */
export const NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * An `@name` in bullet text. The `@` has to start a word, the same rule the
 * mention autocomplete uses, so an email address is not read as a variable.
 */
export const varRefRe = () => /(?<![^\s([{])@([A-Za-z0-9_]+)/g;

const STORAGE_KEY = 'wm.promptdata';

/** The table always ends in a blank row — that empty row *is* the "add" control. */
const BLANK: PromptVar = { name: '', value: '' };

/** Rows with exactly one blank row at the end, whatever came in. */
export function withBlankRow(rows: PromptVar[]): PromptVar[] {
  const filled = rows.filter((r) => r.name !== '' || r.value !== '');
  return [...filled, { ...BLANK }];
}

function load(): PromptVar[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return withBlankRow([]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return withBlankRow([]);
    return withBlankRow(
      parsed
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({ name: String(r.name ?? ''), value: String(r.value ?? '') })),
    );
  } catch {
    return withBlankRow([]);
  }
}

let rows: PromptVar[] = load();
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPromptVars(): PromptVar[] {
  return rows;
}

/** Replace the whole table. The blank last row is kept in step here, once. */
export function setPromptVars(next: PromptVar[]): void {
  rows = withBlankRow(next);
  try {
    // Only the filled rows are worth keeping; the blank one is re-added on load.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(0, -1)));
  } catch {
    /* storage full / unavailable — keep working in-memory */
  }
  listeners.forEach((l) => l());
}

/** The rows, as the settings table edits them (blank last row included). */
export function usePromptVars(): PromptVar[] {
  return useSyncExternalStore(subscribe, getPromptVars, getPromptVars);
}

/**
 * The variables that actually resolve — name → value. A row is skipped unless
 * its name is a usable identifier, and the first of a duplicated name wins,
 * which is also what happens to the map once the server hands it to pbt.
 */
function computeMap(source: PromptVar[]): PromptVarMap {
  const out: PromptVarMap = {};
  for (const r of source) {
    if (NAME_RE.test(r.name) && !(r.name in out)) out[r.name] = r.value;
  }
  return out;
}

export type PromptVarMap = Record<string, string>;

// Derived from `rows` and cached against it, so the map handed to the editor
// keeps its identity between edits — it is a dependency of a good deal of
// rendering.
let cachedMap: PromptVarMap = computeMap(rows);
let cachedFor: PromptVar[] = rows;

/** Name → value: what the editor colours, what the run sends. */
export function promptVarMap(source: PromptVar[] = rows): PromptVarMap {
  if (source !== cachedFor) {
    cachedFor = source;
    cachedMap = computeMap(source);
  }
  return cachedMap;
}

/** The live variables, for the components that colour and complete them. */
export function usePromptVarMap(): PromptVarMap {
  return promptVarMap(usePromptVars());
}
