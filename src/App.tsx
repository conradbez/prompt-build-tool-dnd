import { useCallback, useEffect, useRef, useState } from 'react';
import { MindMap } from './mindmap/MindMap';
import { Outline } from './outline/Outline';
import { Toolbar } from './Toolbar';

const MIN_PCT = 20;
const MAX_PCT = 70;

export default function App() {
  // Width of the right-hand outline as a percentage of the whole screen.
  const [rightPct, setRightPct] = useState(38);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onMove = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((rect.right - clientX) / rect.width) * 100;
    setRightPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)));
  }, []);

  useEffect(() => {
    // Pointer Events cover mouse, touch and pen with one code path.
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      onMove(e.clientX);
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [onMove]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="app" ref={containerRef}>
      <div className="app__left" style={{ width: `${100 - rightPct}%` }}>
        <Toolbar />
        <MindMap />
      </div>

      <div
        className="app__divider"
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="vertical"
      >
        <div className="app__divider-grip" />
      </div>

      <div className="app__right" style={{ width: `${rightPct}%` }}>
        <Outline />
      </div>
    </div>
  );
}
