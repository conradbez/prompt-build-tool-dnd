import { useCallback, useEffect, useState } from 'react';
import { MindMap } from './mindmap/MindMap';
import { Outline } from './outline/Outline';
import { Toolbar } from './Toolbar';
import { Help } from './Help';
import { SWITCH_HINT } from './lib/shortcuts';

type View = 'map' | 'outline';

const NAMES: Record<View, string> = { map: 'mind map', outline: 'outline' };

/**
 * One view at a time. The other is parked top-right as a live thumbnail with a
 * toggle above it: click either — or press the shortcut — to swap them. Both
 * views stay mounted and share one store, so the small one keeps up with edits
 * made in the big one.
 */
export default function App() {
  const [full, setFull] = useState<View>('map');
  const toggle = useCallback(() => setFull((v) => (v === 'map' ? 'outline' : 'map')), []);

  // Mod+\ swaps the views. The modifier keeps it out of the way of typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const other: View = full === 'map' ? 'outline' : 'map';
  const swapLabel = `Switch to the ${NAMES[other]} (${SWITCH_HINT})`;

  return (
    <div className="app">
      <div className={`app__main app__main--${full}`}>
        {full === 'map' ? <MindMap /> : <Outline />}
      </div>

      <Toolbar />

      <div className="app__corner">
        <button className="app__toggle" onClick={toggle} title={swapLabel} aria-label={swapLabel}>
          ⇄
        </button>

        {/* The parked view. It renders for real, just small and inert — the
            wrapper takes the click, so nothing inside it can steal one. */}
        <div
          className={`app__mini app__mini--${other}`}
          role="button"
          tabIndex={0}
          title={swapLabel}
          aria-label={swapLabel}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <div className="app__mini-inner">{other === 'map' ? <MindMap /> : <Outline />}</div>
        </div>
      </div>

      <Help />
    </div>
  );
}
