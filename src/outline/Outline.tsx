import { useLayoutEffect } from 'react';
import { flatten, useOutline } from '../store';
import { getEditor } from './focusRegistry';
import { placeCaret } from '../lib/caret';
import { BulletRow } from './BulletRow';

/**
 * Right panel: the Workflowy-style outline. Reads the shared store, so any
 * change made from the mind map (selection, focus) shows up here too.
 */
export function Outline() {
  const state = useOutline();
  const rows = flatten(state);

  // Apply store-driven focus to the real DOM (after rows have mounted).
  useLayoutEffect(() => {
    const f = state.focus;
    if (!f) return;
    const el = getEditor(f.id);
    if (!el) return;
    el.focus();
    placeCaret(el, f.caret ?? 'end');
    el.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus]);

  return (
    <div className="ol-root">
      <div className="ol-scroll">
        {rows.map(({ id, depth }) => (
          <BulletRow
            key={id}
            bullet={state.bullets[id]}
            depth={depth}
            selected={state.selectedId === id}
          />
        ))}
      </div>
    </div>
  );
}
