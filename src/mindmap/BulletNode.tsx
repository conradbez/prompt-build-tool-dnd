import { Handle, Position, type NodeProps } from '@xyflow/react';
import { actions } from '../store';

export interface BulletNodeData {
  title: string;
  body: string;
  hasChildren: boolean;
  collapsed: boolean;
  result?: string;
  [key: string]: unknown;
}

export function BulletNode({ id, data, selected }: NodeProps) {
  const d = data as BulletNodeData;
  return (
    <div className={`mm-node ${selected ? 'mm-node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="mm-handle" />
      <div className="mm-node__title">{d.title || 'Untitled'}</div>
      {d.body && <div className="mm-node__body">{d.body}</div>}
      {d.result && <div className="mm-node__result">{d.result}</div>}
      {d.hasChildren && d.collapsed && <div className="mm-node__badge">▸</div>}
      <button
        className="mm-node__add"
        title="Add a child node"
        aria-label="Add a child node"
        onClick={(e) => {
          e.stopPropagation();
          actions.addChild(id);
        }}
      >
        ＋
      </button>
      <Handle type="source" position={Position.Bottom} className="mm-handle" />
    </div>
  );
}
