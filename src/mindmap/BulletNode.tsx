import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface BulletNodeData {
  title: string;
  body: string;
  hasChildren: boolean;
  collapsed: boolean;
  result?: string;
  [key: string]: unknown;
}

export function BulletNode({ data, selected }: NodeProps) {
  const d = data as BulletNodeData;
  return (
    <div className={`mm-node ${selected ? 'mm-node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="mm-handle" />
      <div className="mm-node__title">{d.title || 'Untitled'}</div>
      {d.body && <div className="mm-node__body">{d.body}</div>}
      {d.result && <div className="mm-node__result">{d.result}</div>}
      {d.hasChildren && d.collapsed && <div className="mm-node__badge">▸</div>}
      <Handle type="source" position={Position.Bottom} className="mm-handle" />
    </div>
  );
}
