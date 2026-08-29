import { useLayoutEffect, useRef, useState } from 'react';
import { actions, flatten, getState, useOutline } from '../store';
import { getEditor } from './focusRegistry';
import { placeCaret } from '../lib/caret';
import { BulletRow } from './BulletRow';
import { computeDrop, INDENT, type DropTarget, type RowRect } from './dragDrop';

/** Pointer travel before a press on a bullet dot becomes a drag (px). */
const DRAG_SLOP = 4;

interface Drag {
  id: string;
  /** The dragged bullet and everything under it — not valid drop targets. */
  subtree: string[];
  startX: number;
  startY: number;
  /** False until the pointer has moved past the slop, so a tap still focuses. */
  active: boolean;
  target: DropTarget | null;
  /** Viewport x of a top-level bullet dot, for placing the indicator. */
  dotBase: number;
}

/**
 * Right panel: the Workflowy-style outline. Reads the shared store, so any
 * change made from the mind map (selection, focus) shows up here too.
 *
 * Drag and drop follows Workflowy: press a bullet's **dot** and move, and the
 * row you are dragging stays put with a grey highlight while a line shows where
 * it will land. The line's left edge is the nesting level — drag right to nest
 * under the row above, left to pop out — and dropping moves the bullet with its
 * whole subtree. Works with a mouse or a finger; the dot is the only handle, so
 * dragging never fights with selecting text.
 */
export function Outline() {
  const state = useOutline();
  const rows = flatten(state);
  const [drag, setDrag] = useState<Drag | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  /**
   * Measure the visible rows, minus the subtree being dragged. `dotBase` is
   * where a top-level bullet's dot sits, so the drop indicator can line its
   * circle up with the real bullets of whatever level it is snapping to.
   */
  function measure(exclude: string[]): { rects: RowRect[]; dotBase: number } {
    const scroll = scrollRef.current;
    const rects: RowRect[] = [];
    let dotBase = 0;
    for (const { id, depth } of flatten(getState())) {
      const el = scroll?.querySelector(`[data-row="${id}"]`) as HTMLElement | null;
      if (!el) continue;
      const dot = el.querySelector('.ol-dot') as HTMLElement | null;
      if (dot) dotBase = dot.getBoundingClientRect().x - depth * INDENT;
      if (exclude.includes(id)) continue;
      const r = el.getBoundingClientRect();
      rects.push({ id, depth, top: r.y, bottom: r.y + r.height });
    }
    return { rects, dotBase };
  }

  function onDragStart(id: string, e: React.PointerEvent) {
    const s = getState();
    const subtree = [id];
    const walk = (bid: string) => {
      for (const c of s.bullets[bid]?.children ?? []) {
        subtree.push(c);
        walk(c);
      }
    };
    walk(id);
    // Keep receiving moves even if the pointer leaves the dot. Browsers throw
    // if the pointer is no longer active, and it isn't worth failing over.
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
    setDrag({ id, subtree, startX: e.clientX, startY: e.clientY, active: false, target: null, dotBase: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (!drag.active && moved < DRAG_SLOP) return;
    e.preventDefault();
    const s = getState();
    const { rects, dotBase } = measure(drag.subtree);
    // Sideways movement is measured from where the drag began.
    const target = computeDrop(rects, e.clientX, e.clientY, drag.startX, {
      parentOf: (bid) => s.bullets[bid]?.parentId ?? null,
      childrenOf: (pid) => (pid ? (s.bullets[pid]?.children ?? []) : s.rootIds),
    });
    setDrag({ ...drag, active: true, target, dotBase });
  }

  function onPointerUp() {
    if (drag?.active && drag.target) {
      actions.moveTo(drag.id, drag.target.parentId, drag.target.index);
    }
    setDrag(null);
  }

  const scroll = scrollRef.current?.getBoundingClientRect();

  return (
    <div
      className={`ol-root ${drag?.active ? 'ol-root--dragging' : ''}`}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="ol-scroll" ref={scrollRef}>
        {rows.map(({ id, depth }) => (
          <BulletRow
            key={id}
            bullet={state.bullets[id]}
            depth={depth}
            selected={state.selectedId === id}
            dragging={drag?.active === true && drag.subtree.includes(id)}
            onDragStart={onDragStart}
            result={state.results[id]}
            onExpand={actions.openResult}
          />
        ))}

        {/* The drop indicator. Its circle sits exactly on the bullet column of
            the level being chosen, so the nesting reads at a glance. */}
        {drag?.active && drag.target && scroll && (
          <div
            className="ol-drop"
            style={{
              top: drag.target.y - scroll.y + (scrollRef.current?.scrollTop ?? 0),
              left: drag.dotBase + drag.target.depth * INDENT - scroll.x,
            }}
          >
            <span className="ol-drop__dot" />
            <span className="ol-drop__line" />
          </div>
        )}
      </div>
    </div>
  );
}
