import type { Field } from '../types';

/**
 * Maps every mounted editor (`bulletId:field`) to its DOM node so that focus —
 * driven by shared store state — can be applied from anywhere, including a
 * click on the mind map.
 */
const registry = new Map<string, HTMLTextAreaElement>();

const key = (id: string, field: Field) => `${id}:${field}`;

export function register(id: string, field: Field, el: HTMLTextAreaElement | null) {
  const k = key(id, field);
  if (el) registry.set(k, el);
  else registry.delete(k);
}

export function getEditor(id: string, field: Field): HTMLTextAreaElement | undefined {
  return registry.get(key(id, field));
}
