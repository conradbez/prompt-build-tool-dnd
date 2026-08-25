import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { actions, useOutline } from '../store';
import { layout, NODE_WIDTH, NODE_HEIGHT } from './layout';
import { BulletNode, type BulletNodeData } from './BulletNode';

const nodeTypes = { bullet: BulletNode };

/**
 * Left panel: a mind map of the same bullet tree the outline shows on the
 * right. Parent→child links are solid; `@` references are dashed. Clicking a
 * node focuses that bullet in the outline (shared selection state).
 */
export function MindMap() {
  const state = useOutline();

  const nodes = useMemo<Node[]>(() => {
    const placed = layout(state);
    return placed.map((p) => {
      const b = state.bullets[p.id];
      const data: BulletNodeData = {
        title: b.title,
        body: b.body,
        hasChildren: b.children.length > 0,
        collapsed: b.collapsed,
        result: state.results[p.id],
      };
      return {
        id: p.id,
        type: 'bullet',
        position: { x: p.x, y: p.y },
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

  const onNodeClick: NodeMouseHandler = (_, node) => {
    actions.setFocus({ id: node.id, field: 'title', caret: 'end' });
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
        onEdgeClick={onEdgeClick}
        onEdgesDelete={onEdgesDelete}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        nodesDraggable={false}
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
