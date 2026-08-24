/**
 * Helpers for the Workflowy-style `@` mention. Typing `@` starts a query that
 * runs until the next whitespace; picking a bullet inserts its title and links
 * the two bullets (which draws a dashed edge on the mind map).
 */

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

/** Replace the active `@query` with `@Title ` and report the new caret. */
export function applyMention(
  text: string,
  mentionStart: number,
  caret: number,
  title: string,
): { text: string; caret: number } {
  const before = text.slice(0, mentionStart);
  const after = text.slice(caret);
  const insert = `@${title} `;
  return { text: before + insert + after, caret: before.length + insert.length };
}
