/**
 * Helpers for the Workflowy-style `@` mention. Typing `@` starts a query that
 * runs until the next whitespace; picking a bullet links the two.
 *
 * A mention is stored as a **token carrying the target's id** — `@[[<id>]]` —
 * not its title. Ids are minted once (`nanoid`) and never change, so a mention
 * survives the target being renamed, reordered, indented or re-parented.
 *
 * The editor never shows the token. Text goes through `toDisplay` on the way
 * into a textarea (token → a short label of the target's current title) and
 * back through `displayToRaw` on the way out, so the caret, selection and every
 * keyboard handler work on ordinary-looking text.
 */

/** How many characters of the target's title a mention shows. */
export const MENTION_LABEL_CHARS = 10;

const tokenRe = () => /@\[\[([A-Za-z0-9_-]+)\]\]/g;

/** Titles keyed by bullet id — what a token resolves against. */
export type TitleMap = Record<string, string>;

export function mentionToken(id: string): string {
  return `@[[${id}]]`;
}

/** The visible form of a mention: `@` + the first 10 chars of the title. */
export function mentionLabel(title: string | undefined): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '@Untitled';
  return '@' + (t.length > MENTION_LABEL_CHARS ? t.slice(0, MENTION_LABEL_CHARS) + '…' : t);
}

/** Ids mentioned in a raw string, in order, without duplicates. */
export function mentionIds(raw: string): string[] {
  const ids: string[] = [];
  for (const m of raw.matchAll(tokenRe())) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** Drop every mention of `id` from a raw string (used when a link is cut). */
export function stripMention(raw: string, id: string): string {
  return raw.replace(tokenRe(), (tok, found) => (found === id ? '' : tok));
}

export interface Segment {
  text: string;
  /** Set when this segment is a mention — the id it points at. */
  id?: string;
}

/** Split raw text into plain runs and mention runs, for coloured rendering. */
export function toSegments(raw: string, titles: TitleMap): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of raw.matchAll(tokenRe())) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: raw.slice(last, at) });
    out.push({ text: mentionLabel(titles[m[1]]), id: m[1] });
    last = at + m[0].length;
  }
  if (last < raw.length) out.push({ text: raw.slice(last) });
  return out;
}

/** Raw (ids) → what the user sees and edits (short labels). */
export function toDisplay(raw: string, titles: TitleMap): string {
  return raw.replace(tokenRe(), (_, id) => mentionLabel(titles[id]));
}

/** Every mention expanded to the target's full title — what the server sends
 *  to the LLM, so a prompt reads naturally instead of carrying raw ids. */
export function resolveMentions(raw: string, titles: TitleMap): string {
  return raw.replace(tokenRe(), (_, id) => {
    const t = (titles[id] ?? '').replace(/\s+/g, ' ').trim();
    return t ? `@${t}` : '';
  });
}

/**
 * What the user typed (labels) → raw (ids), the inverse of `toDisplay`.
 *
 * The labels in `oldRaw` are matched against `display` **in order**, so two
 * bullets sharing the same first ten characters still map back to the right
 * ids. A label the user edited into no longer matches, which drops that
 * mention — the intended outcome of typing over one.
 */
export function displayToRaw(display: string, oldRaw: string, titles: TitleMap): string {
  let out = '';
  let rest = display;
  for (const m of oldRaw.matchAll(tokenRe())) {
    const label = mentionLabel(titles[m[1]]);
    const at = rest.indexOf(label);
    if (at === -1) continue; // edited away — the mention goes with it
    out += rest.slice(0, at) + m[0];
    rest = rest.slice(at + label.length);
  }
  return out + rest;
}

export interface MentionQuery {
  /** Text typed after the `@`, lower-cased for matching. */
  query: string;
  /** Index of the `@` in the source string. */
  start: number;
}

/** If the caret sits inside an active `@mention`, return its query. */
export function detectMention(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  const between = upto.slice(at + 1);
  // A space or newline ends the mention.
  if (/\s/.test(between)) return null;
  // `@` must start a word (beginning of text or preceded by whitespace).
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  return { query: between.toLowerCase(), start: at };
}

/**
 * Accept a mention: replace the active `@query` in the *display* string with
 * the target's label, and return the new raw text plus the new caret.
 *
 * The freshly picked mention is threaded through as a sentinel so that
 * `displayToRaw` — which only knows about the mentions already in `oldRaw` —
 * leaves it alone; it becomes the id token afterwards.
 */
const SENTINEL = '\u0000';

export function applyMention(
  display: string,
  oldRaw: string,
  mentionStart: number,
  caret: number,
  target: { id: string; title: string },
  titles: TitleMap,
): { raw: string; display: string; caret: number } {
  const before = display.slice(0, mentionStart);
  const after = display.slice(caret);
  const label = mentionLabel(target.title);
  // The trailing space is part of both forms, so display and raw stay in step.
  const raw = displayToRaw(before + SENTINEL + ' ' + after, oldRaw, titles).replace(
    SENTINEL,
    mentionToken(target.id),
  );
  return {
    raw,
    display: before + label + ' ' + after,
    caret: before.length + label.length + 1,
  };
}
