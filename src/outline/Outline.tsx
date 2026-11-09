import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DraggableRenderer, translate, type Draggable, type DragSpecBuilder, type Svgx } from 'dragology';
import { actions, blockIds, canTakeChild, flatten, getState, titleMap, useOutline } from '../store';
import { toDisplay } from '../lib/mentions';
import { getEditor } from './focusRegistry';
import { placeCaret } from '../lib/caret';
import { showHint } from '../lib/hint';
import { ROW_KEYS } from '../lib/shortcuts';
import { BulletRow } from './BulletRow';
import { dropStates, INDENT, moveToIndex, treeKey, visibleTree, type DragState, type TreeNode } from './dragTree';

/** Pointer travel before a press on a bullet dot becomes a drag (px). */
const DRAG_SLOP = 4;

/** A row's height before it has been measured. */
const ROW_GUESS = 28;

/** What the rows, mounted inside the SVG, report back to the outline. */
interface RowCtxValue {
  setHeight: (id: string, h: number) => void;
  block: Set<string>;
}
const RowCtx = createContext<RowCtxValue | null>(null);

/** SVG ids can't be bare bullet ids (they may start with a digit). */
const layerId = (id: string) => `b-${id}`;

/**
 * Right panel: the Workflowy-style outline. Reads the shared store, so any
 * change made from the mind map (selection, focus) shows up here too.
 *
 * Drag and drop is Workflowy-style, built on dragology (declarative
 * dragging): the rows are drawn as an SVG tree, each row's HTML living in a
 * `<foreignObject>`. Press a bullet's **dot** and move: the bullet and its
 * subtree float with the pointer while the rest of the outline opens a gap
 * where it would land. Every possible landing spot is a whole alternative
 * outline (see `dragTree.ts`); dragology renders them and picks the one that
 * puts the bullet nearest the pointer, so moving sideways chooses the nesting
 * level — right to nest under the row above, left to pop out. The dot is the
 * only handle, so dragging never fights with selecting text.
 */
export function Outline() {
  const state = useOutline();
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [width, setWidth] = useState(0);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The row a mouse text-selection started in. Dragging it into another row
  // turns the selection into whole bullets, as Workflowy does.
  const textDrag = useRef<string | null>(null);
  const block = new Set(blockIds(state));

  // Apply store-driven focus to the real DOM (after rows have mounted).
  useLayoutEffect(() => {
    const f = state.focus;
    if (!f) return;
    const el = getEditor(f.id, f.field ?? 'title');
    if (!el) return;
    if (document.activeElement !== el) el.focus();
    // No caret means the focus came from a click, which already placed it.
    if (f.caret) placeCaret(el, f.caret);
    el.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus]);

  // Keys while whole bullets are selected. No textarea has focus then, so
  // they arrive at the window.
  useEffect(() => {
    if (!state.blockSel) return;
    function onKey(e: KeyboardEvent) {
      const ids = blockIds(getState());
      if (ids.length === 0) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        actions.setBlockSel(null);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        actions.deleteBullets(ids);
      } else if (e.key === 'Enter' && mod && e.shiftKey) {
        e.preventDefault();
        actions.addParents(ids);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        actions.shiftBullets(ids, e.shiftKey ? -1 : 1);
      } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        extendBlock(e.key === 'ArrowUp' ? -1 : 1);
      } else if (mod && (e.key === 'c' || e.key === 'x')) {
        e.preventDefault();
        void navigator.clipboard.writeText(blockText(ids));
        if (e.key === 'x') actions.deleteBullets(ids);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const edge = e.key === 'ArrowUp' ? ids[0] : ids[ids.length - 1];
        actions.setFocus(
          e.key === 'ArrowUp'
            ? { id: edge, field: 'title', caret: 'start' }
            : { id: edge, field: 'body', caret: 'end' },
        );
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.blockSel]);

  /** Move the moving end of the block one visible row up or down. */
  function extendBlock(dir: -1 | 1) {
    const s = getState();
    if (!s.blockSel) return;
    const ids = flatten(s).map((r) => r.id);
    const next = ids[ids.indexOf(s.blockSel.head) + dir];
    if (next) actions.setBlockSel({ ...s.blockSel, head: next });
  }

  /** The row under a viewport y, or null between/outside rows. */
  function rowAt(y: number): string | null {
    for (const { id } of flatten(getState())) {
      const el = scrollRef.current?.querySelector(`[data-row="${id}"]`);
      const r = el?.getBoundingClientRect();
      if (r && y >= r.top && y < r.bottom) return id;
    }
    return null;
  }

  function onPointerDownCapture(e: React.PointerEvent) {
    if (getState().blockSel) actions.setBlockSel(null);
    const t = e.target as HTMLElement;
    // Only a press in a bullet's text starts a selection; the dot drags.
    textDrag.current =
      e.pointerType === 'mouse' && e.button === 0 && t.closest('.ol-view')
        ? (t.closest('[data-row]') as HTMLElement | null)?.dataset.row ?? null
        : null;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (textDrag.current && e.buttons & 1) {
      const over = rowAt(e.clientY);
      const anchor = textDrag.current;
      if (over && (over !== anchor || getState().blockSel)) {
        if (!getState().blockSel) {
          // From here on it's rows, not characters: drop the caret and the
          // half-made text selection so only the row highlight shows.
          (document.activeElement as HTMLElement | null)?.blur();
          window.getSelection()?.removeAllRanges();
          actions.setFocus(null);
        }
        actions.setBlockSel({ anchor, head: over });
      }
      return;
    }
  }

  function onPointerUp() {
    textDrag.current = null;
  }

  // The content width the rows lay out in.
  useLayoutEffect(() => {
    const el = sizerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Only rebuilt when the visible structure changes, not on every keystroke.
  const key = treeKey(visibleTree(state));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree: DragState = useMemo(() => ({ roots: visibleTree(getState()) }), [key]);

  const draggable = useMemo(() => makeDraggable({ heights, width }), [heights, width]);

  const rowCtx: RowCtxValue = {
    setHeight: (id, h) => setHeights((hs) => (hs[id] === h ? hs : { ...hs, [id]: h })),
    block,
  };

  function onDrop(next: DragState) {
    const move = next.move;
    if (!move) return; // let go far from any landing spot: nothing moves
    const s = getState();
    const before = s.bullets[move.id]?.parentId ?? null;
    actions.moveTo(move.id, move.parentId, moveToIndex(s, move));
    // A drag is usually a reorder or a re-nest — both have keys.
    if (before === move.parentId) {
      showHint(`${ROW_KEYS.moveUp} / ${ROW_KEYS.moveDown}`, 'moves a bullet up / down');
    } else {
      showHint(`${ROW_KEYS.indent} / ${ROW_KEYS.outdent}`, 'indents / outdents');
    }
  }

  return (
    <div
      className={`ol-root ${dragging ? 'ol-root--dragging' : ''}`}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="ol-scroll" ref={scrollRef}>
        <div ref={sizerRef} className="ol-sizer">
          {width > 0 && (
            <RowCtx.Provider value={rowCtx}>
              <DraggableRenderer
                draggable={draggable}
                state={tree}
                width={width}
                height={treeHeight(tree.roots, heights)}
                dragThreshold={DRAG_SLOP}
                onDropState={onDrop}
                onDragStatus={(st) => {
                  const on = st.type === 'dragging';
                  if (on !== draggingRef.current) {
                    draggingRef.current = on;
                    setDragging(on);
                  }
                }}
              />
            </RowCtx.Provider>
          )}
        </div>
      </div>
    </div>
  );
}

interface Layout {
  heights: Record<string, number>;
  width: number;
}

const noop = () => {};

const rowHeight = (heights: Record<string, number>, id: string) => heights[id] ?? ROW_GUESS;

function treeHeight(nodes: TreeNode[], heights: Record<string, number>): number {
  return nodes.reduce((h, n) => h + rowHeight(heights, n.id) + treeHeight(n.children, heights), 0);
}

/**
 * The outline as a dragology draggable: a pure function from a (possibly
 * hypothetical) tree to SVG. Each bullet is a layer holding its row and,
 * nested inside it, its children's layers — so dragging a bullet carries its
 * whole subtree along.
 */
function makeDraggable(layout: Layout): Draggable<DragState> {
  return ({ state, d, draggedId }) => (
    <g>{renderNodes(state.roots, 0, state, d, draggedId, layout, { n: 0 }).elems}</g>
  );
}

function renderNodes(
  nodes: TreeNode[],
  depth: number,
  state: DragState,
  d: DragSpecBuilder<DragState>,
  draggedId: string | null,
  layout: Layout,
  /** Rows drawn so far, top to bottom — the stacking order. */
  count: { n: number },
): { elems: Svgx[]; h: number } {
  let y = 0;
  const elems = nodes.map((node) => {
    const row = count.n++;
    const rowH = rowHeight(layout.heights, node.id);
    const kids = renderNodes(node.children, depth + 1, state, d, draggedId, layout, count);
    const lid = layerId(node.id);
    const elem = (
      // The no-op `onClick` is a flag for dragology: it can't see the dot's
      // own click handler inside the row component, and with no click handler
      // in sight it starts the drag on press, swallowing the click that opens
      // the bullet. With one, a press becomes a drag only after `DRAG_SLOP`.
      <g
        id={lid}
        transform={translate(0, y)}
        onClick={noop}
        // Each row paints over the rows below it, so a menu or autocomplete
        // list dropping out of a row isn't covered by the next one (HTML
        // z-index can't reach across foreignObjects). The order is fixed by
        // the outline, never by hover or focus: re-stacking moves DOM nodes,
        // which would eat clicks and blur the field being typed in.
        dragologyZIndex={draggedId === lid ? '/1' : `/${-1 - row}`}
        dragologyOnDrag={() => {
          const s = getState();
          const targets = dropStates(state.roots, node.id, (pid) => canTakeChild(s, pid, node.id));
          return d.closest(targets).whenFar(state).withFloating();
        }}
      >
        <foreignObject
          className="ol-fo"
          width={Math.max(0, layout.width - depth * INDENT)}
          height={rowH}
        >
          <RowSlot id={node.id} dragging={draggedId === lid} />
        </foreignObject>
        {kids.elems.length > 0 && <g transform={translate(INDENT, rowH)}>{kids.elems}</g>}
      </g>
    );
    y += rowH + kids.h;
    return elem;
  });
  return { elems, h: y };
}

/**
 * One row, mounted by dragology inside its `<foreignObject>`. It reads the
 * store itself and reports its natural height, which the layout above stacks.
 * Presses anywhere but the dot are kept from the drag, so the text stays
 * editable and selectable.
 */
function RowSlot({ id, dragging }: { id: string; dragging: boolean }) {
  const state = useOutline();
  const ctx = useContext(RowCtx)!;
  const ref = useRef<HTMLDivElement | null>(null);
  const report = ctx.setHeight;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => report(id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const bullet = state.bullets[id];
  if (!bullet) return null;
  return (
    <div
      ref={ref}
      className="ol-slot"
      onPointerDown={(e) => {
        if (!(e.target as Element).closest('.ol-dot')) e.stopPropagation();
      }}
      >
      <BulletRow
        bullet={bullet}
        selected={state.selectedId === id}
        inBlock={ctx.block.has(id)}
        dragging={dragging}
        result={state.results[id]}
        test={state.tests[id]}
        runStatus={state.runStatus[id]}
        failure={state.runFailures[id]}
        files={state.files[id]}
        onExpand={actions.openResult}
      />
    </div>
  );
}

/**
 * A block as an indented plain-text list, ready to paste into anything — the
 * shallowest bullet of the block sits at the margin.
 */
function blockText(ids: string[]): string {
  const rows = flatten(getState()).filter((r) => ids.includes(r.id));
  const base = Math.min(...rows.map((r) => r.depth));
  const s = getState();
  const titles = titleMap(s);
  return rows
    .map((r) => {
      const pad = '  '.repeat(r.depth - base);
      const b = s.bullets[r.id];
      const body = toDisplay(b.text, titles);
      return [`${pad}- ${b.title}`, ...(body ? body.split('\n').map((line) => `${pad}  ${line}`) : [])].join('\n');
    })
    .join('\n');
}
