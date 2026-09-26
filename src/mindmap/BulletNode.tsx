import { Handle, Position, type NodeProps } from '@xyflow/react';
import { actions } from '../store';
import { PYTHON_CAPTION, type BulletKind, type TestStatus } from '../types';

export interface BulletNodeData {
  /** The bullet's markdown, already rendered (mentions included). */
  html: string;
  hasChildren: boolean;
  /** False on a python node that already holds its one child. */
  canAddChild: boolean;
  collapsed: boolean;
  kind: BulletKind;
  /** An agent node's MCP server command, named in its chip's tooltip. */
  mcpServer: string;
  /** Whether this bullet's answer is validated as JSON — shown as a chip. */
  jsonOutput: boolean;
  /** How many files are attached — shown as a paperclip count. */
  fileCount: number;
  /** True once this bullet has a result from the latest run. */
  hasResult: boolean;
  /** A test node's verdict from the latest run; absent until it has one. */
  test?: TestStatus;
  [key: string]: unknown;
}

export function BulletNode({ id, data, selected }: NodeProps) {
  const d = data as BulletNodeData;
  return (
    <div
      className={`mm-node ${selected ? 'mm-node--selected' : ''} ${d.kind !== 'prompt' ? `mm-node--${d.kind}` : ''} ${
        d.kind === 'test' ? `mm-node--test-${d.test ?? 'idle'}` : ''
      }`}
    >
      {/*
        One circle, two gestures: drag from it to start a link, click it to add
        a child. They used to be separate controls sitting on top of each other
        — the `+` button covering the connection handle — so a drag aimed at the
        handle hit the button instead. The `+` now lives *inside* the handle.

        It is the node's *input*, on the left: children sit left of their parent
        and feed their output across into it, so adding a child means adding an input.
      */}
      <Handle
        type="target"
        position={Position.Left}
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
      {(d.kind !== 'prompt' || d.jsonOutput || d.fileCount > 0) && (
        <div className="mm-node__flags">
          {d.kind !== 'prompt' && <KindChip kind={d.kind} mcpServer={d.mcpServer} test={d.test} />}
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
      {d.kind === 'test' ? (
        <TestTag id={id} status={d.test} />
      ) : d.hasResult && (
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
      {/* The output: it links across into this node's parent. A test has
          none — its verdict never feeds anything. */}
      {d.kind !== 'test' && <Handle type="source" position={Position.Right} className="mm-handle" />}
    </div>
  );
}

/** What each test state says, on the node and in its tooltip. */
const TEST_LABELS: Record<TestStatus | 'idle', [string, string]> = {
  idle: ['untested', 'Not run yet — connect the nodes it checks into it, then press Run'],
  skipped: ['not run', 'Something it checks failed, so this test never ran'],
  pass: ['passed', 'The assertion held — open the verdict'],
  fail: ['failed', 'The assertion did not hold — open the verdict'],
};

/**
 * A test node's verdict, in place of the `success` tag every other node wears:
 * a test that ran is not "successful" — it passed or it failed, and that is the
 * one thing it is on the map to say.
 */
function TestTag({ id, status }: { id: string; status?: TestStatus }) {
  const [label, title] = TEST_LABELS[status ?? 'idle'];
  return (
    <button
      className={`mm-node__test mm-node__test--${status ?? 'idle'}`}
      title={title}
      disabled={!status}
      onClick={(e) => {
        e.stopPropagation();
        actions.openResult(id);
      }}
    >
      {label}
    </button>
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

/**
 * The `TPL` / `PY` / `AGENT` / `TEST` badge. A prompt is the default and wears
 * nothing. A test's chip takes its verdict's colour, so the outline — which has
 * no node to colour — shows it too.
 */
export function KindChip({
  kind,
  mcpServer = '',
  test,
  className = '',
}: {
  kind: BulletKind;
  mcpServer?: string;
  test?: TestStatus;
  className?: string;
}) {
  if (kind === 'prompt') return null;
  if (kind === 'test') {
    const [label, title] = TEST_LABELS[test ?? 'idle'];
    return (
      <span
        className={`tpl-chip tpl-chip--test tpl-chip--test-${test ?? 'idle'} ${className}`}
        title={`Test: ${label}. ${title}.`}
      >
        TEST
      </span>
    );
  }
  const [label, title] =
    kind === 'template'
      ? ['TPL', 'Not sent to the LLM — its text, with refs filled in, is its output']
      : kind === 'agent'
        ? [
            mcpServer ? 'AGENT+MCP' : 'AGENT',
            'A coding agent works on this text as its task, in a Modal sandbox — its output is {output, logs, run_time}. ' +
              (mcpServer ? `MCP server: ${mcpServer}` : 'No MCP server: bash only.'),
          ]
        : ['PY', 'Runs its child\u2019s code in a Modal sandbox — what it prints is its output'];
  return (
    <span className={`tpl-chip tpl-chip--${kind} ${className}`} title={title}>
      {label}
    </span>
  );
}
