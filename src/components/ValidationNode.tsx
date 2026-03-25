import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { PlusIcon, Trash2Icon } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export const PROP_TYPES = ['str', 'int', 'float', 'bool', 'list', 'dict'] as const;
export type PropType = (typeof PROP_TYPES)[number];

export interface ValidationProperty {
  id: string;
  name: string;
  type: PropType;
  /** 0 = top-level field, 1 = sub-field (child of nearest depth-0 row above). */
  depth: number;
}

export interface ValidationNodeData {
  /** The prompt model name this node validates. Empty if not yet connected. */
  targetModel: string;
  properties: ValidationProperty[];
}

// ── Component ──────────────────────────────────────────────────────────────────

function ValidationNode({ id, data, selected }: NodeProps) {
  const { setNodes } = useReactFlow();
  const d = data as unknown as ValidationNodeData;

  // Update this node's data without touching other nodes
  const updateData = useCallback(
    (patch: Partial<ValidationNodeData>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [id, setNodes],
  );

  const addProperty = useCallback(() => {
    updateData({
      properties: [
        ...(d.properties ?? []),
        { id: crypto.randomUUID(), name: '', type: 'str', depth: 0 },
      ],
    });
  }, [d.properties, updateData]);

  const updateProperty = useCallback(
    (propId: string, patch: Partial<ValidationProperty>) => {
      updateData({
        properties: (d.properties ?? []).map((p) =>
          p.id === propId ? { ...p, ...patch } : p,
        ),
      });
    },
    [d.properties, updateData],
  );

  const removeProperty = useCallback(
    (propId: string) => {
      updateData({ properties: (d.properties ?? []).filter((p) => p.id !== propId) });
    },
    [d.properties, updateData],
  );

  const toggleIndent = useCallback(
    (index: number) => {
      const props = [...(d.properties ?? [])];
      const prop = props[index];
      if (prop.depth === 0) {
        // Only indent if there is a depth-0 row above (so there's a parent)
        if (index > 0) {
          props[index] = { ...prop, depth: 1 };
          updateData({ properties: props });
        }
      } else {
        props[index] = { ...prop, depth: 0 };
        updateData({ properties: props });
      }
    },
    [d.properties, updateData],
  );

  const properties = d.properties ?? [];

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl cursor-pointer',
        'transition-all duration-200',
        'min-w-[280px]',
        selected
          ? 'shadow-[0_0_0_2px_#10b981,0_8px_24px_rgba(16,185,129,0.18)]'
          : 'shadow-[0_2px_8px_rgba(0,0,0,0.10)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.14)]',
      )}
      style={{
        background: selected
          ? 'linear-gradient(135deg,#f0fdf4 0%,#dcfce7 100%)'
          : 'linear-gradient(135deg,#f8fffe 0%,#f0fdf4 100%)',
        border: selected ? '2px solid #10b981' : '1.5px solid #a7f3d0',
      }}
    >
      {/* Receives connections from prompt nodes */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !rounded-full !border-2 !border-emerald-300 !bg-white !-left-1.5"
      />

      {/* Header */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-emerald-100">
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-500 text-[9px] font-bold tracking-widest uppercase">
            ✓ validate
          </span>
          {d.targetModel ? (
            <span className="font-mono font-semibold text-sm text-emerald-800 truncate max-w-[180px]">
              {d.targetModel}
            </span>
          ) : (
            <span className="text-[11px] text-emerald-400 italic">connect a model</span>
          )}
        </div>
      </div>

      {/* Property rows */}
      <div className="px-2 py-1.5 flex flex-col gap-0.5">
        {properties.map((prop, index) => {
          // A depth-0 row is a "parent" (nested model) if the next row is depth-1
          const isParent = prop.depth === 0 && properties[index + 1]?.depth === 1;
          const canIndent = prop.depth === 0 && index > 0;
          const canUnindent = prop.depth === 1;

          return (
            <div
              key={prop.id}
              className="flex items-center gap-1"
              style={{ paddingLeft: prop.depth === 1 ? '16px' : '0' }}
            >
              {prop.depth === 1 && (
                <span className="text-emerald-300 text-[10px] shrink-0 leading-none">↳</span>
              )}

              {/* Field name */}
              <input
                className="nodrag flex-1 min-w-0 text-xs font-mono px-1.5 py-0.5 border border-emerald-200 rounded bg-white focus:outline-none focus:border-emerald-400"
                value={prop.name}
                onChange={(e) => updateProperty(prop.id, { name: e.target.value })}
                placeholder={prop.depth === 1 ? 'sub_field' : 'field_name'}
              />

              {/* Type dropdown — hidden for parent rows (they become nested classes) */}
              {!isParent ? (
                <select
                  className="nodrag text-[11px] border border-emerald-200 rounded bg-white px-1 py-0.5 text-emerald-700 focus:outline-none focus:border-emerald-400 cursor-pointer"
                  value={prop.type}
                  onChange={(e) =>
                    updateProperty(prop.id, { type: e.target.value as PropType })
                  }
                >
                  {PROP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[10px] text-emerald-400 italic px-1 shrink-0">obj</span>
              )}

              {/* Indent toggle */}
              <button
                className={cn(
                  'nodrag shrink-0 text-[11px] px-0.5 leading-none',
                  canIndent || canUnindent
                    ? 'text-emerald-400 hover:text-emerald-600'
                    : 'text-emerald-200 cursor-default',
                )}
                onClick={() => toggleIndent(index)}
                title={prop.depth === 0 ? 'Indent as sub-property' : 'Unindent to top level'}
              >
                {prop.depth === 0 ? '⇥' : '⇤'}
              </button>

              {/* Remove */}
              <button
                className="nodrag shrink-0 text-rose-400 hover:text-rose-600"
                onClick={() => removeProperty(prop.id)}
                title="Remove property"
              >
                <Trash2Icon size={11} />
              </button>
            </div>
          );
        })}

        {properties.length === 0 && (
          <p className="text-[10px] text-emerald-400 italic py-0.5 px-1">
            No fields yet
          </p>
        )}

        {/* Add property */}
        <button
          className="nodrag mt-0.5 flex items-center gap-1 text-[10px] text-emerald-600 hover:text-emerald-800 px-1 py-0.5"
          onClick={addProperty}
        >
          <PlusIcon size={10} />
          Add field
        </button>
      </div>
    </div>
  );
}

export default memo(ValidationNode);
