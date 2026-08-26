import { useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  ConnectionMode,
  type Node,
  type Edge,
  type Connection,
  type FinalConnectionState,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { actions, useOutline, titleMap } from '../store';
import { renderMarkdown } from '../lib/markdown';
import { layout, NODE_WIDTH, NODE_HEIGHT } from './layout';
import { BulletNode, type BulletNodeData } from './BulletNode';

const nodeTypes = { bullet: BulletNode };

/** Pointer movement below this is a click, not a drag (px). */
const DRAG_SLOP = 6;

/**
 * Left panel: a mind map of the same bullet tree the outline shows on the
 * right. Parent→child links are solid; `@` references are dashed.
 *
 * Interaction model
 * -----------------
 * Mouse:
 *   - click a node ................. focus that bullet in the outline
 *   - drag a node .................. move it; the node keeps that spot
 *                                    (`bullet.pos`) instead of following the
 *                                    auto-layout
 *   - drag from the `+` circle ..... start a link from that node
 *   - drop the link on a node ...... link them (see `onConnect` for whether
 *                                    that means "child of" or "@ reference")
 *   - drop the link on the canvas .. create a new node there, as a child
 *   - click the `+` circle ......... create a child node (no drag needed)
 *   - click a link ................. delete it (confirms first)
 *   - scroll / pinch ............... pan and zoom the canvas
 *
 * Touch — the same gestures, sized for fingers:
 *   - tap a node ................... focus that bullet
 *   - drag a node .................. move it
 *   - drag from the `+` circle ..... start a link (the circle is always
 *                                    visible on touch, and 26px across)
 *   - tap a link ................... delete it (confirms first)
 *   - one finger ................... pan; two fingers pinch to zoom
 *
 * Keyboard shortcuts on the canvas are deliberately off — see the props on
 * `ReactFlow` below — so typing in the outline is never intercepted.
 */
export function MindMap() {
  const state = useOutline();

  const nodes = useMemo<Node[]>(() => {
    const placed = layout(state);
    const titles = titleMap(state);
    return placed.map((p) => {
      const b = state.bullets[p.id];
      const data: BulletNodeData = {
        html: renderMarkdown(b.text, titles),
        hasChildren: b.children.length > 0,
        collapsed: b.collapsed,
        template: b.template,
        result: state.results[p.id],
      };
      return {
        id: p.id,
        type: 'bullet',
        position: b.pos ?? { x: p.x, y: p.y },
        data,
        selected: state.selectedId === p.id,
        deletable: false,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
    });
  }, [state]);

  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = [];
    for (const b of Object.values(state.bullets)) {
      if (!b.collapsed) {
        for (const c of b.children) {
          if (state.bullets[c]) {
            list.push({ id: `e-${b.id}-${c}`, source: b.id, target: c });
          }
        }
      }
      for (const r of b.refs) {
        if (state.bullets[r]) {
          list.push({
            id: `r-${b.id}-${r}`,
            source: b.id,
            target: r,
            animated: true,
            style: { stroke: '#a855f7', strokeDasharray: '5 5' },
          });
        }
      }
    }
    return list;
  }, [state]);

  /**
   * Dropping a link on a node either adopts it or references it:
   *
   * - the target has **no parent** → it becomes a child of the source. Dragging
   *   a loose node under another one is how you build the tree, and a solid
   *   edge is almost always what was meant.
   * - the target already sits somewhere in the tree → an `@` reference, so the
   *   existing parent link is left alone. That writes a mention into the source
   *   bullet's text, which is what the dashed edge is drawn from.
   */
  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const target = state.bullets[c.target];
    if (target && target.parentId === null) actions.reparent(c.target, c.source);
    else actions.addRef(c.source, c.target);
  };

  /**
   * A link dropped on empty canvas creates the node it was heading for, as a
   * child of where it started. A *click* on the `+` circle also ends here with
   * no target, so anything that barely moved is left to the button's own
   * handler — otherwise one tap would make two nodes.
   */
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const onConnectStart = (e: MouseEvent | TouchEvent) => {
    const p = 'touches' in e ? e.touches[0] : e;
    dragStart.current = p ? { x: p.clientX, y: p.clientY } : null;
  };

  const onConnectEnd = (e: MouseEvent | TouchEvent, conn: FinalConnectionState) => {
    const from = dragStart.current;
    dragStart.current = null;
    if (!from || conn.toNode || !conn.fromNode) return; // landed on a node: onConnect has it
    const p = 'changedTouches' in e ? e.changedTouches[0] : e;
    if (!p) return;
    if (Math.hypot(p.clientX - from.x, p.clientY - from.y) < DRAG_SLOP) return; // a click, not a drag
    const id = actions.addChild(conn.fromNode.id);
    if (id && conn.to) actions.setPos(id, { x: conn.to.x - NODE_WIDTH / 2, y: conn.to.y });
  };

  /** A dragged node stops following the auto-layout. */
  const onNodeDragStop: OnNodeDrag = (_, node) => {
    actions.setPos(node.id, node.position);
  };

  const onNodeClick: NodeMouseHandler = (_, node) => {
    actions.setFocus({ id: node.id, caret: 'end' });
  };

  // Deleting a parent→child link makes the child a top-level node; deleting a
  // reference (dashed) link just drops the reference.
  const deleteEdge = (e: Edge) => {
    if (e.id.startsWith('r-')) actions.removeRef(e.source, e.target);
    else actions.reparent(e.target, null);
  };
  const onEdgesDelete = (deleted: Edge[]) => deleted.forEach(deleteEdge);

  // Tap-to-delete a link (touch-friendly; Delete/Backspace also works).
  const onEdgeClick = (_: unknown, edge: Edge) => {
    const isRef = edge.id.startsWith('r-');
    const msg = isRef ? 'Remove this reference?' : 'Detach this node to the top level?';
    if (window.confirm(msg)) deleteEdge(edge);
  };

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodeDragStop={onNodeDragStop}
        // Loose mode lets a drag end anywhere on the target node instead of
        // demanding its little dot — the difference between usable and not on
        // a touchscreen. Click-to-connect stays off so a tap still focuses.
        connectionMode={ConnectionMode.Loose}
        connectOnClick={false}
        onEdgeClick={onEdgeClick}
        onEdgesDelete={onEdgesDelete}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        // Disable the canvas's global keyboard shortcuts so typing in the
        // outline is never intercepted — Space (default pan key) was swallowing
        // spacebar, and Backspace/Delete could eat edits. Links delete by tap.
        panActivationKeyCode={null}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomActivationKeyCode={null}
        panOnScroll
        zoomOnPinch
        panOnDrag
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#e5e7eb" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
