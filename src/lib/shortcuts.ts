/**
 * Keyboard shortcut labels. Its own module because both `App` (which owns the
 * binding) and `Help` (which documents it) need them — importing one from the
 * other would be a cycle, and the constant would read as undefined.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Swaps the mind map and the outline. */
export const SWITCH_HINT = IS_MAC ? '⌘\\' : 'Ctrl+\\';
