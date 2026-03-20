import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';

export type PromptNodeData = {
  label: string;
  hasOutput: boolean;
  isRunning: boolean;
  isTemplate: boolean;
  isLoop: boolean;
  loopOver: string;
};

function PromptNode({ data, selected }: NodeProps) {
  const d = data as PromptNodeData;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl cursor-pointer',
        'transition-all duration-200',
        'min-w-[160px]',
        selected
          ? 'shadow-[0_0_0_2px_#6366f1,0_8px_24px_rgba(99,102,241,0.18)]'
          : 'shadow-[0_2px_8px_rgba(0,0,0,0.10)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.14)]',
      )}
      style={{
        background: selected
          ? 'linear-gradient(135deg,#f5f3ff 0%,#ede9fe 100%)'
          : 'linear-gradient(135deg,#ffffff 0%,#f8fafc 100%)',
        border: selected ? '2px solid #6366f1' : '1.5px solid #e2e8f0',
      }}
    >
      {/* target handle (left – receives connections from upstream models) */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !rounded-full !border-2 !border-indigo-300 !bg-white !-left-1.5"
      />

      <div className="px-4 py-3">
        {/* Node label */}
        <div className="font-mono font-semibold text-sm text-slate-800 truncate max-w-[200px] leading-tight">
          {d.label}
        </div>

        {/* Status row */}
        <div className="mt-1.5 flex items-center gap-1.5">
          {d.isRunning ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 font-semibold tracking-wide uppercase">
              <span className="animate-spin inline-block">⟳</span> running
            </span>
          ) : d.hasOutput ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 font-semibold tracking-wide uppercase">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" /> done
            </span>
          ) : (
            <span className="text-[10px] text-slate-400 tracking-wide">click to edit</span>
          )}
          {d.isTemplate && (
            <span className="group relative inline-flex items-center rounded-full bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 cursor-help">
              template
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 rounded-lg bg-slate-800 px-3 py-2 text-[11px] text-white leading-snug shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50">
                Not processed by AI — input is passed directly as output to the next model.
                <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
              </span>
            </span>
          )}
          {d.isLoop && (
            <span className="group relative inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 cursor-help">
              loop
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 rounded-lg bg-slate-800 px-3 py-2 text-[11px] text-white leading-snug shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50">
                Iterates over each item from an upstream JSON array. Output is a combined JSON array.
                <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
              </span>
            </span>
          )}
        </div>
      </div>

      {/* source handle (right – this model feeds into downstream models) */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !rounded-full !border-2 !border-indigo-300 !bg-white !-right-1.5"
      />
    </div>
  );
}

export default memo(PromptNode);
