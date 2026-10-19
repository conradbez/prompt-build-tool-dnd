import type { Field } from '../types';

/**
 * Maps every mounted editor to its DOM node by bullet id and field (title or
 * body), so that focus — driven by shared store state — can be applied from
 * anywhere, including a click on the mind map.
 */
const registry = new Map<string, HTMLTextAreaElement>();

const key = (id: string, field: Field) => `${id}:${field}`;

export function register(id: string, field: Field, el: HTMLTextAreaElement | null) {
  if (el) registry.set(key(id, field), el);
  else registry.delete(key(id, field));
}

export function getEditor(id: string, field: Field = 'body'): HTMLTextAreaElement | undefined {
  return registry.get(key(id, field));
}
