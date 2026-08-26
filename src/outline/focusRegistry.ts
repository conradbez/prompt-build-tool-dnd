/**
 * Maps every mounted editor to its DOM node by bullet id, so that focus —
 * driven by shared store state — can be applied from anywhere, including a
 * click on the mind map.
 */
const registry = new Map<string, HTMLTextAreaElement>();

export function register(id: string, el: HTMLTextAreaElement | null) {
  if (el) registry.set(id, el);
  else registry.delete(id);
}

export function getEditor(id: string): HTMLTextAreaElement | undefined {
  return registry.get(id);
}
