import { Handle, Position, type NodeProps } from '@xyflow/react';
import { actions } from '../store';
export interface BulletNodeData {
  /** The bullet's markdown, already rendered (mentions included). */
  html: string;
  hasChildren: boolean;
  collapsed: boolean;
  template: boolean;
  /** How many files are attached — shown as a paperclip count. */
  fileCount: number;
  result?: string;
  [key: string]: unknown;
}

export function BulletNode({ id, data, selected }: NodeProps) {
  const d = data as BulletNodeData;
  return (
    <div className={`mm-node ${selected ? 'mm-node--selected' : ''} ${d.template ? 'mm-node--template' : ''}`}>
      <Handle type="target" position={Position.Top} className="mm-handle" />
      {(d.template || d.fileCount > 0) && (
        <div className="mm-node__flags">
          {d.template && (
            <span className="tpl-chip" title="Not sent to the LLM">
              TPL
            </span>
          )}
          {d.fileCount > 0 && (
            <span className="mm-node__files" title={`${d.fileCount} attached file(s)`}>
              📎 {d.fileCount}
            </span>
          )}
        </div>
      )}
      <div
        className="mm-node__md"
        dangerouslySetInnerHTML={{ __html: d.html || '<p class="mm-node__empty">Empty</p>' }}
      />
      {d.result && <div className="mm-node__result">{d.result}</div>}
      {d.hasChildren && d.collapsed && <div className="mm-node__badge">▸</div>}
      {/*
        One circle, two gestures: drag from it to start a link, click it to add
        a child. They used to be separate controls sitting on top of each other
        — the `+` button covering the connection handle — so a drag aimed at the
        handle hit the button instead. The `+` now lives *inside* the handle.
      */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="mm-handle mm-handle--start"
        title="Drag to link, click to add a child"
        onClick={(e) => {
          e.stopPropagation();
          actions.addChild(id);
        }}
      >
        <span className="mm-handle__plus">＋</span>
      </Handle>
    </div>
  );
}
