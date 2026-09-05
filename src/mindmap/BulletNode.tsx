import { Handle, Position, type NodeProps } from '@xyflow/react';
import { actions } from '../store';
import { PYTHON_CAPTION, type BulletKind } from '../types';

export interface BulletNodeData {
  /** The bullet's markdown, already rendered (mentions included). */
  html: string;
  hasChildren: boolean;
  /** False on a python node that already holds its one child. */
  canAddChild: boolean;
  collapsed: boolean;
  kind: BulletKind;
  /** Whether this bullet's answer is validated as JSON — shown as a chip. */
  jsonOutput: boolean;
  /** How many files are attached — shown as a paperclip count. */
  fileCount: number;
  /** True once this bullet has a result from the latest run. */
  hasResult: boolean;
  [key: string]: unknown;
}

export function BulletNode({ id, data, selected }: NodeProps) {
  const d = data as BulletNodeData;
  return (
    <div className={`mm-node ${selected ? 'mm-node--selected' : ''} ${d.kind !== 'prompt' ? `mm-node--${d.kind}` : ''}`}>
      <Handle type="target" position={Position.Top} className="mm-handle" />
      {(d.kind !== 'prompt' || d.jsonOutput || d.fileCount > 0) && (
        <div className="mm-node__flags">
          {d.kind !== 'prompt' && <KindChip kind={d.kind} />}
          {d.jsonOutput && <JsonChip />}
          {d.fileCount > 0 && (
            <span className="mm-node__files" title={`${d.fileCount} attached file(s)`}>
              📎 {d.fileCount}
            </span>
          )}
        </div>
      )}
      <div
        className="mm-node__md"
        dangerouslySetInnerHTML={{
          __html:
            d.kind === 'python'
              ? `<p class="mm-node__empty">${PYTHON_CAPTION}</p>`
              : d.html || '<p class="mm-node__empty">Empty</p>',
        }}
      />
      {/* A tag, not the answer. A node's job on the map is to show the shape
          of the graph; an LLM answer pasted into it buries that under a wall
          of text, and the answer has a place of its own — the modal. */}
      {d.hasResult && (
        <button
          className="mm-node__ok"
          title="Ran successfully — open the answer"
          onClick={(e) => {
            e.stopPropagation();
            actions.openResult(id);
          }}
        >
          success
        </button>
      )}
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
        title={
          d.canAddChild
            ? 'Drag to link, click to add a child'
            : 'A python node runs one child, and already has it'
        }
        onClick={(e) => {
          e.stopPropagation();
          actions.addChild(id);
        }}
      >
        {d.canAddChild && <span className="mm-handle__plus">＋</span>}
      </Handle>
    </div>
  );
}

/**
 * The `JSON` badge. Orthogonal to the kind — a prompt, a template or a python
 * bullet can each be held to JSON — so it is its own chip beside that one.
 */
export function JsonChip({ className = '' }: { className?: string }) {
  return (
    <span
      className={`tpl-chip tpl-chip--json ${className}`}
      title="The answer is parsed and validated as JSON; one that is not JSON fails this bullet"
    >
      JSON
    </span>
  );
}

/** The `TPL` / `PY` badge. A prompt bullet is the default and wears nothing. */
export function KindChip({ kind, className = '' }: { kind: BulletKind; className?: string }) {
  if (kind === 'prompt') return null;
  const [label, title] =
    kind === 'template'
      ? ['TPL', 'Not sent to the LLM — its text, with refs filled in, is its output']
      : ['PY', 'Runs its child\u2019s code in a Modal sandbox — what it prints is its output'];
  return (
    <span className={`tpl-chip tpl-chip--${kind} ${className}`} title={title}>
      {label}
    </span>
  );
}
