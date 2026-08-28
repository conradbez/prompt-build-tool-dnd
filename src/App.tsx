import { useCallback, useEffect, useState } from 'react';
import { MindMap } from './mindmap/MindMap';
import { Outline } from './outline/Outline';
import { Toolbar } from './Toolbar';
import { Help } from './Help';
import { SWITCH_HINT } from './lib/shortcuts';

type View = 'map' | 'outline';

const NAMES: Record<View, string> = { map: 'mind map', outline: 'outline' };

/** Below this the thumbnail costs more room than it is worth. */
const COMPACT = '(max-width: 720px)';

function useCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(COMPACT).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(COMPACT);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return compact;
}

/**
 * One view at a time. The other is parked top-right as a live thumbnail you
 * click to swap them — the thumbnail *is* the control, so there is no separate
 * button next to it. On a narrow screen, where a thumbnail would eat the space
 * the view needs, it gives way to a small toggle button instead. Either way the
 * shortcut works, and both views stay mounted on one store, so the parked one
 * keeps up with edits made in the other.
 */
export default function App() {
  const [full, setFull] = useState<View>('map');
  const compact = useCompact();
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
        {compact ? (
          <button className="app__toggle" onClick={toggle} title={swapLabel} aria-label={swapLabel}>
            ⇄
          </button>
        ) : (
          /* The parked view. It renders for real, just small and inert — the
             wrapper takes the click, so nothing inside it can steal one. */
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
        )}
      </div>

      <Help />
    </div>
  );
}
