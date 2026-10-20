import { useHint } from './lib/hint';

/** The toast for `showHint` — bottom centre, out of the way, gone on its own. */
export function ShortcutHint() {
  const hint = useHint();
  if (!hint) return null;
  return (
    <div className="hint" role="status" key={hint.n}>
      <kbd className="hint__keys">{hint.keys}</kbd>
      <span>{hint.desc}</span>
    </div>
  );
}
