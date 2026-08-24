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
      };
      return {
        id: p.id,
        type: 'bullet',
        position: { x: p.x, y: p.y },
        data,
        selected: state.selectedId === p.id,
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

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#e5e7eb" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
