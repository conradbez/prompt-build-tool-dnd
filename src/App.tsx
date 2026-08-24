import { useCallback, useEffect, useRef, useState } from 'react';
import { MindMap } from './mindmap/MindMap';
import { Outline } from './outline/Outline';

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
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      onMove(e.clientX);
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onMove]);

  const startDrag = () => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="app" ref={containerRef}>
      <div className="app__left" style={{ width: `${100 - rightPct}%` }}>
        <MindMap />
      </div>

      <div className="app__divider" onMouseDown={startDrag} role="separator" aria-orientation="vertical">
        <div className="app__divider-grip" />
      </div>

      <div className="app__right" style={{ width: `${rightPct}%` }}>
        <Outline />
      </div>
    </div>
  );
}
