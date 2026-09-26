/**
 * Keyboard shortcut labels. Its own module because both `App` (which owns the
 * binding) and `Help` (which documents it) need them — importing one from the
 * other would be a cycle, and the constant would read as undefined.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Swaps the mind map and the outline. */
export const SWITCH_HINT = IS_MAC ? '⌘\\' : 'Ctrl+\\';

/**
 * The outline row's own keys, shown beside their `•••` menu items. They are
 * bound in the row's editor only — the mind map and the answer modal have no
 * such bindings, so their menus leave these out.
 */
export const ROW_KEYS = {
  addBelow: 'Enter',
  indent: 'Tab',
  outdent: IS_MAC ? '⇧Tab' : 'Shift+Tab',
  moveUp: IS_MAC ? '⌥⇧↑' : 'Alt+Shift+↑',
  moveDown: IS_MAC ? '⌥⇧↓' : 'Alt+Shift+↓',
};
