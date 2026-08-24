/** Small helpers for reasoning about the caret inside a <textarea>. */

export function caretAtStart(el: HTMLTextAreaElement): boolean {
  return el.selectionStart === 0 && el.selectionEnd === 0;
}

export function caretAtEnd(el: HTMLTextAreaElement): boolean {
  return el.selectionStart === el.value.length && el.selectionStart === el.selectionEnd;
}

/** True when the caret is on the first visual line (no newline before it). */
export function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
  return !el.value.slice(0, el.selectionStart).includes('\n');
}

/** True when the caret is on the last visual line (no newline after it). */
export function caretOnLastLine(el: HTMLTextAreaElement): boolean {
  return !el.value.slice(el.selectionStart).includes('\n');
}

export function placeCaret(el: HTMLTextAreaElement, where: 'start' | 'end') {
  const pos = where === 'start' ? 0 : el.value.length;
  el.setSelectionRange(pos, pos);
}
