import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  ConnectionMode,
  useNodesState,
  type Node,
  type Edge,
  type Connection,
  type FinalConnectionState,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { actions, getState, useOutline, titleMap } from '../store';
import { renderMarkdown } from '../lib/markdown';
import { layout, snapToGrid, NODE_WIDTH, NODE_HEIGHT, SNAP_GRID } from './layout';
import { BulletNode, type BulletNodeData } from './BulletNode';

const nodeTypes = { bullet: BulletNode };

/** Pointer movement below this is a click, not a drag (px). */
const DRAG_SLOP = 6;

/**
 * Props applied **only on touch devices**. A mouse gets React Flow's defaults
 * — its keybindings included, so Backspace removes a selected link and Space
 * pans, which is what anyone who has used a node editor expects. React Flow
 * ignores those keys while a textarea has focus, so they never eat an edit in
 * the outline; clicking the canvas hands focus back (see `releaseOutlineFocus`,
 * without which the Delete binding could never fire in this app).
 *
 * None of it survives a touchscreen, which has no keyboard and no hover:
 *   - `ConnectionMode.Loose` — end a link anywhere on the target node rather
 *     than on its small dot;
 *   - the `*KeyCode` nulls — no keyboard to bind, and the canvas listening for
 *     one only risks intercepting the on-screen keyboard;
 *   - `panOnScroll` / `zoomOnPinch` / `panOnDrag` — one finger pans, two pinch.
 */
const TOUCH_ONLY = {
  connectionMode: ConnectionMode.Loose,
  panActivationKeyCode: null,
  deleteKeyCode: null,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  zoomActivationKeyCode: null,
  panOnScroll: true,
  zoomOnPinch: true,
  panOnDrag: true,
} as const;

/**
 * Left panel: a mind map of the same bullet tree the outline shows on the
 * right. Parent→child links are solid; `@` references are dashed.
 *
 * Interaction model
 * -----------------
 * With a mouse the canvas behaves like any React Flow canvas — its own
 * defaults, keybindings included — with exactly one exception, the `+` circle:
 *   - click a node ................. focus that bullet in the outline
 *   - drag a node .................. move it; the node keeps that spot
 *                                    (`bullet.pos`) instead of following the
 *                                    auto-layout
 *   - drag from the `+` circle ..... start a link from that node
 *   - drop the link on a node ...... link them (see `onConnect` for whether
 *                                    that means "child of" or "@ reference")
 *   - drop the link on the canvas .. create a new node there, as a child
 *   - click the `+` circle ......... create a child node — **the exception**;
 *                                    React Flow would start a click-connection
 *                                    here, so `connectOnClick` is off
 *   - click a link, then Backspace . remove it — React Flow's own selection and
 *                                    its default `deleteKeyCode`, which is
 *                                    Backspace (Delete is not bound), reaching
 *                                    `onEdgesDelete`
 *   - Space-drag / scroll / ctrl .. pan and zoom, per React Flow's defaults
 *
 * Touch has no keyboard and no hover, so it gets its own set (`TOUCH_ONLY`):
 *   - tap a node ................... focus that bullet
 *   - drag a node .................. move it
 *   - drag from the `+` circle ..... start a link; the circle is always
 *                                    visible and 26px across, and a link may
 *                                    end anywhere on the target node
 *   - tap a link ................... delete it (confirms first) — standing in
 *                                    for the Backspace binding
 *   - one finger ................... pan; two fingers pinch to zoom
 */
export function MindMap() {
  const state = useOutline();
  // Coarse pointer = touch. Read once: this doesn't change under you in
  // practice, and re-reading it per render would churn the canvas props.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const touch = useMemo(
    () => (typeof window !== 'undefined' ? window.matchMedia?.('(pointer: coarse)').matches === true : false),
    [],
  );

  const computedNodes = useMemo<Node[]>(() => {
    const placed = layout(state);
    const titles = titleMap(state);
    return placed.map((p) => {
      const b = state.bullets[p.id];
      const data: BulletNodeData = {
        html: renderMarkdown(b.text, titles),
        hasChildren: b.children.length > 0,
        collapsed: b.collapsed,
        template: b.template,
        fileCount: b.files.length,
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

  /**
   * React Flow needs somewhere to put a node's position *while* it is being
   * dragged. With a controlled `nodes` prop and no `onNodesChange`, it has
   * nowhere — the node stays pinned under the cursor doing nothing and only
   * jumps once `onNodeDragStop` writes to the store. So the canvas keeps its
   * own copy, re-synced whenever the store changes, and the drag writes
   * through to `bullet.pos` when it ends.
   */
  const [nodes, setNodes, onNodesChange] = useNodesState(computedNodes);
  useEffect(() => setNodes(computedNodes), [computedNodes, setNodes]);

  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = [];
    for (const b of Object.values(state.bullets)) {
      if (!b.collapsed) {
        for (const c of b.children) {
          if (state.bullets[c]) {
            const id = `e-${b.id}-${c}`;
            list.push({ id, source: b.id, target: c, selected: id === selectedEdge });
          }
        }
      }
      for (const r of b.refs) {
        if (state.bullets[r]) {
          const id = `r-${b.id}-${r}`;
          list.push({
            id,
            source: b.id,
            target: r,
            animated: true,
            selected: id === selectedEdge,
            style: { stroke: '#a855f7', strokeDasharray: '5 5' },
          });
        }
      }
    }
    return list;
  }, [state, selectedEdge]);

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
    if (!id || !conn.to) return;
    // Keep the x you dropped at, but take the y from the nodes it is joining,
    // so a new child lines up with the children already sitting beside it
    // rather than hanging wherever the pointer happened to be.
    const parentId = conn.fromNode.id;
    const siblingY = nodes
      .filter((n) => n.id !== id && state.bullets[n.id]?.parentId === parentId)
      .map((n) => n.position.y);
    const y = siblingY.length ? Math.min(...siblingY) : conn.to.y;
    actions.setPos(id, snapToGrid({ x: conn.to.x - NODE_WIDTH / 2, y }));
  };

  /** A dragged node stops following the auto-layout. */
  const onNodeDragStop: OnNodeDrag = (_, node) => {
    actions.setPos(node.id, node.position);
  };

  const onNodeClick: NodeMouseHandler = (_, node) => {
    actions.setFocus({ id: node.id, caret: 'end' });
  };

  // Deleting a parent→child link makes the child a top-level node; deleting a
  // reference (dashed) link just drops the reference. On a pointer device this
  // runs from React Flow's own Delete/Backspace handling; on touch, from a tap.
  const deleteEdge = (e: Edge) => {
    if (e.id.startsWith('r-')) actions.removeRef(e.source, e.target);
    else actions.reparent(e.target, null);
  };
  const onEdgesDelete = (deleted: Edge[]) => {
    setSelectedEdge(null);
    deleted.forEach(deleteEdge);
  };

  /**
   * Clicking the canvas or a link hands keyboard focus back to it.
   *
   * The outline keeps a focused textarea whenever a bullet has the caret, and
   * React Flow deliberately ignores its keys while an input is focused — so
   * without this, selecting a link and pressing Delete would do nothing at all.
   * Clicking a *node* is different: that focuses its bullet on purpose.
   */
  const releaseOutlineFocus = () => {
    if (getState().focus) actions.setFocus(null);
  };

  /**
   * Select a link, and take the caret out of the outline so the Delete key
   * reaches the canvas. The selected id is ours rather than React Flow's
   * because every store change rebuilds `edges`, which would drop its flag.
   */
  const onEdgeSelect = (_: unknown, edge: Edge) => {
    setSelectedEdge(edge.id);
    releaseOutlineFocus();
  };

  // Touch has no Delete key, so a tap on a link removes it (after confirming).
  const onEdgeTap = (_: unknown, edge: Edge) => {
    const isRef = edge.id.startsWith('r-');
    const msg = isRef ? 'Remove this reference?' : 'Detach this node to the top level?';
    if (window.confirm(msg)) deleteEdge(edge);
  };

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodeDragStop={onNodeDragStop}
        onEdgesDelete={onEdgesDelete}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        // Dragged nodes land on the same lattice the auto-layout uses, so a
        // hand-placed node still lines up with its neighbours.
        snapToGrid
        snapGrid={SNAP_GRID}
        // The one place a pointer device departs from React Flow's defaults:
        // click-to-connect would swallow the click on the `+` circle, and that
        // click is how you add a child node.
        connectOnClick={false}
        onPaneClick={() => {
          setSelectedEdge(null);
          releaseOutlineFocus();
        }}
        {...(touch ? TOUCH_ONLY : {})}
        {...(touch
          ? { onEdgeClick: onEdgeTap }
          : { onEdgeClick: onEdgeSelect })}
      >
        <Background gap={20} color="#e5e7eb" />
        {/* Top-left: the provider/key/Run toolbar now sits bottom-left. */}
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>
    </div>
  );
}
