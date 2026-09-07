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

/**
 * The one variable the *server* reads as well as renders: a comma-separated
 * list of packages a python bullet's sandbox installs before it runs. It stays
 * an ordinary variable, so `@python_depn` in the prompt that writes the
 * script tells the model what it may import in the same breath as telling the
 * sandbox what to install.
 */
export const PYTHON_DEPS_VAR = 'python_depn';

/**
 * The boilerplate for a prompt that asks a model for a script: that its answer
 * is executed rather than read, what the sandbox already has, and how to ask
 * for more (a PEP 723 header). It needs no row — the *server* writes its value
 * on the way past, because only the server knows which packages that sandbox
 * actually has. Whatever is sent under this name is replaced.
 */
export const STANDARD_INSTRUCTIONS_VAR = 'coding_instructions';

/**
 * The variables the app knows by name. They are always in the table, in this
 * order and above the rest: their *value* is yours to set, their name is not —
 * the server looks them up by name, so a renamed one is simply a variable the
 * server no longer finds, which is a silent failure rather than an edit.
 * Deleting one would be the same thing, so they cannot be deleted either.
 */
export interface ReservedVar {
  name: string;
  /** Shown on hover, and in place of the value when it is empty. */
  hint: string;
  placeholder: string;
}

export const RESERVED: ReservedVar[] = [
  {
    name: PYTHON_DEPS_VAR,
    hint:
      'Comma-separated packages every python bullet’s sandbox installs before ' +
      'it runs, on top of numpy, pandas and requests.',
    placeholder: 'beautifulsoup4, lxml, scipy==1.*',
  },
  {
    name: STANDARD_INSTRUCTIONS_VAR,
    hint:
      'What to tell a model being asked for a script: that its answer is run ' +
      'rather than read, which packages the sandbox has, and how to ask for ' +
      'more with a PEP 723 header. Left empty, the server writes it — and only ' +
      'the server knows the real package list. Fill it in to say your own thing.',
    placeholder: 'Left empty, the server writes this for you',
  },
];

export function isReserved(name: string): boolean {
  return RESERVED.some((r) => r.name === name);
}

export function reservedVar(name: string): ReservedVar | undefined {
  return RESERVED.find((r) => r.name === name);
}

/** What a variable's tooltip should say — its value, or why it has none yet. */
export function describeVar(name: string, value: string): string {
  if (value) return value;
  const reserved = reservedVar(name);
  return reserved ? reserved.hint : '(empty)';
}

const STORAGE_KEY = 'wm.promptdata';

/** The table always ends in a blank row — that empty row *is* the "add" control. */
const BLANK: PromptVar = { name: '', value: '' };

/**
 * The table's rows: the reserved ones first — always, even empty — then
 * whatever a person added, then one blank row to type the next into.
 *
 * Every write goes through here, which is what makes the reserved rows
 * permanent: deleting one, or clearing both its fields, just puts it back.
 */
export function withBlankRow(rows: PromptVar[]): PromptVar[] {
  const byName = new Map(rows.filter((r) => r.name !== '').map((r) => [r.name, r]));
  const reserved = RESERVED.map((r) => ({ name: r.name, value: byName.get(r.name)?.value ?? '' }));
  const rest = rows.filter(
    (r) => !isReserved(r.name) && (r.name !== '' || r.value !== ''),
  );
  return [...reserved, ...rest, { ...BLANK }];
}

/** Names these variables used to have, and what they are called now. */
export const RENAMED: Record<string, string> = {
  avail_python_depn: PYTHON_DEPS_VAR,
  standard_coding_instructions: STANDARD_INSTRUCTIONS_VAR,
};

/** Carry a stored name across a rename. Unknown names come back unchanged. */
export function renamed(name: string): string {
  return RENAMED[name] ?? name;
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
        .map((r) => ({ name: renamed(String(r.name ?? '')), value: String(r.value ?? '') })),
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
