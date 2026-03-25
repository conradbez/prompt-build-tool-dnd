import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type OnConnectEnd,
  type ReactFlowInstance,
  BackgroundVariant,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMutation } from '@tanstack/react-query';
import { PlusIcon, DatabaseIcon, FileIcon, KeyIcon, RepeatIcon, ChevronDownIcon, UploadIcon, DownloadIcon, ShieldCheckIcon } from 'lucide-react';

import PromptNode, { type PromptNodeData } from './PromptNode';
import ValidationNode, { type ValidationNodeData, type ValidationProperty } from './ValidationNode';
import NodePanel from './NodePanel';
import PromptDataManager, { type PromptDataRow } from './PromptDataManager';
import PromptFileManager, { type PromptFileRow } from './PromptFileManager';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { runDag, uploadFileToServer, USE_SERVER, type LlmProvider } from '../api';
import {
  getPyScriptBridgeState,
  subscribePyScriptBridgeState,
  type PyScriptBridgeState,
} from '@/lib/pyscriptBridge';
import {
  DEFAULT_PROVIDER_KEYS,
  hydrateProviderKeyState,
  PROVIDER_KEYS_STORAGE_KEY,
} from '@/lib/providerKeyState';
import { buildUserModelState, hydrateUserModelState, type UserModelState } from '@/lib/userModelState';

// ── Module-level constants (stable across renders) ────────────────────────────

const nodeTypes = { promptNode: PromptNode, validationNode: ValidationNode };
const PROVIDERS: LlmProvider[] = ['gemini', 'openai', 'anthropic'];
const USER_MODEL_STATE_STORAGE_KEY = 'pbt_user_model_state';

// Stable no-op; only needed to satisfy ReactFlow's onConnectEnd prop type
const handleConnectEnd: OnConnectEnd = () => {};

let _nodeCounter = 1;
function makeNodeId() {
  return `node_${Date.now()}_${_nodeCounter++}`;
}

/** Regex to extract completed ref('name') calls from a Jinja2 template. */
const REF_RE = /ref\(['"]([^'"]+)['"]\)/g;

function extractRefs(source: string): string[] {
  return [...new Set([...source.matchAll(REF_RE)].map((m) => m[1]))];
}

function getInitialProviderKeys(): Record<LlmProvider, string> {
  try {
    const hydratedProviderKeys = hydrateProviderKeyState(
      localStorage.getItem(PROVIDER_KEYS_STORAGE_KEY),
    );
    console.log('[pbt] Loaded provider API keys from local storage.', {
      providers: PROVIDERS.filter((provider) => Boolean(hydratedProviderKeys[provider])),
    });
    return hydratedProviderKeys;
  } catch {
    localStorage.removeItem(PROVIDER_KEYS_STORAGE_KEY);
    return DEFAULT_PROVIDER_KEYS;
  }
}

// ── Validation code generation ────────────────────────────────────────────────

function toPascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generate the contents of a validation/<targetModel>.py file from a ValidationNode's
 * property definitions, building Pydantic models for nested structures.
 */
function generateValidationCode(data: ValidationNodeData): string {
  const modelName = toPascalCase(data.targetModel);
  const properties = (data.properties ?? []).filter((p) => p.name.trim());

  if (properties.length === 0) {
    return [
      'def validate(prompt: str, result: str) -> bool:',
      '    return True',
      '',
    ].join('\n');
  }

  interface PropGroup {
    name: string;
    type: string;
    children: { name: string; type: string }[];
  }

  // Build groups: each depth-0 row is a top-level field; depth-1 rows are children
  const groups: PropGroup[] = [];
  let current: PropGroup | null = null;
  for (const prop of properties) {
    if (prop.depth === 0) {
      current = { name: prop.name, type: prop.type, children: [] };
      groups.push(current);
    } else if (prop.depth === 1 && current) {
      current.children.push({ name: prop.name, type: prop.type });
    }
  }

  const lines: string[] = ['import json', 'from pydantic import BaseModel, ValidationError', ''];

  // Nested classes first
  for (const group of groups) {
    if (group.children.length > 0) {
      const nestedName = toPascalCase(group.name) + 'Model';
      lines.push(`class ${nestedName}(BaseModel):`);
      for (const child of group.children) {
        lines.push(`    ${child.name}: ${child.type}`);
      }
      lines.push('');
    }
  }

  // Main model class
  lines.push(`class ${modelName}(BaseModel):`);
  for (const group of groups) {
    if (group.children.length > 0) {
      lines.push(`    ${group.name}: ${toPascalCase(group.name)}Model`);
    } else {
      lines.push(`    ${group.name}: ${group.type}`);
    }
  }
  lines.push('');
  lines.push('');
  lines.push('def validate(prompt: str, result: str) -> bool:');
  lines.push('    try:');
  lines.push('        data = json.loads(result)');
  lines.push(`        ${modelName}(**data)`);
  lines.push('        return True');
  lines.push('    except (json.JSONDecodeError, ValidationError):');
  lines.push('        return False');
  lines.push('');

  return lines.join('\n');
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

/** Return the IDs of targetLabel's node plus all its transitive ancestors. */
function getAncestorIds(targetLabel: string, nodes: Node[], edges: Edge[]): Set<string> {
  const nameToId = new Map(
    nodes
      .filter((n) => n.type !== 'validationNode')
      .map((n) => [(n.data as PromptNodeData).label, n.id]),
  );
  const targetId = nameToId.get(targetLabel);
  if (!targetId) return new Set();

  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!parents.has(edge.target)) parents.set(edge.target, []);
    parents.get(edge.target)!.push(edge.source);
  }

  const visited = new Set<string>();
  const queue = [targetId];
  while (queue.length) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const p of parents.get(id) ?? []) queue.push(p);
  }
  return visited;
}

/**
 * Build React Flow edges from the per-node ref cache plus validation node connections.
 * Refs are the single source of truth for prompt edges; validation edges come from
 * each ValidationNode's targetModel field.
 */
function computeEdges(nodes: Node[], nodeRefs: Record<string, string[]>): Edge[] {
  const promptNodes = nodes.filter((n) => n.type !== 'validationNode');
  const nameToId = new Map(promptNodes.map((n) => [(n.data as PromptNodeData).label, n.id]));
  const edges: Edge[] = [];

  // Edges derived from ref() calls in prompt templates
  for (const node of promptNodes) {
    for (const refName of nodeRefs[node.id] ?? []) {
      const sourceId = nameToId.get(refName);
      if (sourceId && sourceId !== node.id) {
        edges.push({
          id: `${sourceId}→${node.id}`,
          source: sourceId,
          target: node.id,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#818cf8' },
          style: { stroke: '#818cf8', strokeWidth: 1.5 },
        });
      }
    }
  }

  // Edges from prompt nodes → validation nodes
  for (const node of nodes) {
    if (node.type !== 'validationNode') continue;
    const vData = node.data as unknown as ValidationNodeData;
    if (!vData.targetModel) continue;
    const sourceId = nameToId.get(vData.targetModel);
    if (sourceId) {
      edges.push({
        id: `${sourceId}→${node.id}_validation`,
        source: sourceId,
        target: node.id,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#10b981' },
        style: { stroke: '#10b981', strokeWidth: 1.5, strokeDasharray: '5 3' },
      });
    }
  }

  return edges;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DAGEditor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [nodePrompts, setNodePrompts] = useState<Record<string, string>>({});
  // Per-node extracted ref list — updated whenever a prompt changes (avoids
  // running the regex over every node on every keystroke).
  const [nodeRefs, setNodeRefs] = useState<Record<string, string[]>>({});

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, string>>({});
  const [runErrors, setRunErrors] = useState<string[]>([]);

  // Add-node dialog
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addNodeName, setAddNodeName] = useState('');

  // Add-loop-node dialog
  const [showAddLoopDialog, setShowAddLoopDialog] = useState(false);
  const [addLoopNodeName, setAddLoopNodeName] = useState('');

  // Add-validation-node dialog
  const [showAddValidationDialog, setShowAddValidationDialog] = useState(false);
  const [addValidationTargetModel, setAddValidationTargetModel] = useState('');

  // Manager dialogs
  const [showDataManager, setShowDataManager] = useState(false);
  const [showFileManager, setShowFileManager] = useState(false);
  const [promptDataRows, setPromptDataRows] = useState<PromptDataRow[]>([]);
  const [promptFileRows, setPromptFileRows] = useState<PromptFileRow[]>([]);

  const [selectedProvider, setSelectedProvider] = useState<LlmProvider>('gemini');
  const [providerKeys, setProviderKeys] = useState<Record<LlmProvider, string>>(getInitialProviderKeys);
  const [pyScriptState, setPyScriptState] = useState<PyScriptBridgeState>(getPyScriptBridgeState());

  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const [panelWidth, setPanelWidth] = useState(420);
  const panelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePanelDragStart = useCallback((e: React.MouseEvent) => {
    panelDragRef.current = { startX: e.clientX, startWidth: panelWidth };
    const onMove = (ev: MouseEvent) => {
      if (!panelDragRef.current) return;
      const delta = panelDragRef.current.startX - ev.clientX;
      setPanelWidth(Math.max(280, Math.min(800, panelDragRef.current.startWidth + delta)));
    };
    const onUp = () => {
      panelDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  useEffect(() => subscribePyScriptBridgeState(setPyScriptState), []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const markDirty = useCallback(() => {
    setNodeOutputs({});
    setRunErrors([]);
  }, []);

  const applyLoadedState = useCallback((state: UserModelState) => {
    const hydrated = hydrateUserModelState(state);
    setNodes(hydrated.nodes);
    setNodePrompts(hydrated.nodePrompts);
    setNodeRefs(hydrated.nodeRefs);
    setPromptDataRows(hydrated.promptDataRows);
    setPromptFileRows(hydrated.promptFileRows);
    setSelectedProvider(hydrated.selectedProvider);
    setSelectedNodeId(null);
    setShowAddDialog(false);
    setShowDataManager(false);
    setShowFileManager(false);
    setNodeOutputs(hydrated.nodeOutputs);
    setRunErrors([]);
  }, [setNodes]);

  const handleExportPython = useCallback(async () => {
    // Build prompt model dict (validation nodes are not prompt models)
    const modelDict: Record<string, string> = {};
    for (const n of nodes) {
      if (n.type === 'validationNode') continue;
      const data = n.data as PromptNodeData;
      let source = nodePrompts[n.id] ?? '';
      if (data.isLoop) {
        const loopConfig = data.loopOver.trim()
          ? `{{ config(model_type="loop", loop_over="${data.loopOver.trim()}") }}\n`
          : `{{ config(model_type="loop") }}\n`;
        source = loopConfig + source;
      } else if (data.isTemplate) {
        source = `{{ config(is_template=true) }}\n` + source;
      }
      modelDict[data.label] = source;
    }
    const jsonInline = JSON.stringify(modelDict, null, 2).replace(/\\/g, '\\\\');

    // Build validation section from validation nodes
    const vNodes = nodes.filter(
      (n) => n.type === 'validationNode' &&
        (n.data as unknown as ValidationNodeData).targetModel &&
        (n.data as unknown as ValidationNodeData).properties?.some((p: ValidationProperty) => p.name.trim()),
    );

    let validationSection = '';
    let validationDirArg = '';
    if (vNodes.length > 0) {
      const parts = vNodes.map((vn) => {
        const vData = vn.data as unknown as ValidationNodeData;
        const code = generateValidationCode(vData);
        // Escape backslashes and triple-quotes for embedding in a Python triple-quoted string
        const escaped = code.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
        return (
          `_VALIDATION_${vData.targetModel} = """\\\n${escaped}"""\n` +
          `with open("validation/${vData.targetModel}.py", "w") as _f:\n` +
          `    _f.write(_VALIDATION_${vData.targetModel})\n`
        );
      });
      validationSection = `\nos.makedirs("validation", exist_ok=True)\n${parts.join('\n')}\n`;
      validationDirArg = '\n        validation_dir="validation",';
    }

    const script = `import os
import json
import pbt
from google import genai


def llm_call(prompt: str) -> str:
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return client.models.generate_content(
        model="gemini-3.1-flash-lite-preview",
        contents=prompt,
    ).text
${validationSection}

async def run_pbt():
    results = await pbt.async_run(
        models_from_dict=json.loads(model_export_json),
        llm_call=llm_call,${validationDirArg}
    )
    print(results)


await run_pbt()


# where your model definitions live
model_export_json = \'\'\'
${jsonInline}
\'\'\'
`;
    await navigator.clipboard.writeText(script);
  }, [nodes, nodePrompts]);

  const handleExport = useCallback(async () => {
    const state = await buildUserModelState({
      selectedProvider, nodes, nodePrompts, promptDataRows, promptFileRows, nodeOutputs,
    });
    await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
  }, [selectedProvider, nodes, nodePrompts, promptDataRows, promptFileRows, nodeOutputs]);

  const handleImport = useCallback(async () => {
    const text = await navigator.clipboard.readText();
    const parsed = JSON.parse(text) as UserModelState;
    if (parsed.version !== 1) throw new Error('Invalid state version');
    applyLoadedState(parsed);
  }, [applyLoadedState]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(USER_MODEL_STATE_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as UserModelState;
      if (parsed.version !== 1) return;
      if (!PROVIDERS.includes(parsed.selectedProvider)) return;
      applyLoadedState(parsed);
    } catch {
      localStorage.removeItem(USER_MODEL_STATE_STORAGE_KEY);
    }
  }, [applyLoadedState]);

  useEffect(() => {
    const providersWithKeys = PROVIDERS.filter((provider) => Boolean(providerKeys[provider]));
    if (providersWithKeys.length === 0) {
      console.log('[pbt] Skipped saving empty provider API keys.');
      localStorage.removeItem(PROVIDER_KEYS_STORAGE_KEY);
      return;
    }

    console.log('[pbt] Saved provider API keys to local storage.', {
      providers: providersWithKeys,
    });
    localStorage.setItem(PROVIDER_KEYS_STORAGE_KEY, JSON.stringify(providerKeys));
  }, [providerKeys]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const state = await buildUserModelState({
          selectedProvider,
          nodes,
          nodePrompts,
          promptDataRows,
          promptFileRows,
          nodeOutputs,
        });
        if (!cancelled) {
          localStorage.setItem(USER_MODEL_STATE_STORAGE_KEY, JSON.stringify(state));
        }
      } catch {
        if (!cancelled) {
          localStorage.removeItem(USER_MODEL_STATE_STORAGE_KEY);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedProvider, nodes, nodePrompts, promptDataRows, promptFileRows, nodeOutputs]);

  // ── Computed ──────────────────────────────────────────────────────────────

  const edges = useMemo(() => computeEdges(nodes, nodeRefs), [nodes, nodeRefs]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const allModelNames = useMemo(
    () =>
      nodes
        .filter((n) => n.type !== 'validationNode')
        .map((n) => (n.data as PromptNodeData).label),
    [nodes],
  );

  // O(1) duplicate-name check used in confirmAddNode + handleRename
  const modelNameSet = useMemo(() => new Set(allModelNames), [allModelNames]);

  const otherNodeNames = useMemo(
    () =>
      allModelNames.filter(
        (n) => n !== (selectedNode?.data as PromptNodeData | undefined)?.label,
      ),
    [allModelNames, selectedNode],
  );

  // Promptdata / promptfiles derived for the run API (only filled rows)
  const promptDataForApi = useMemo(() => {
    const entries = promptDataRows.filter((r) => r.name.trim());
    return entries.length > 0
      ? Object.fromEntries(entries.map((r) => [r.name.trim(), r.value]))
      : undefined;
  }, [promptDataRows]);

  // In server mode files are pre-uploaded; the session_id is sent instead of raw bytes.
  const promptFilesForApi = useMemo(() => {
    if (USE_SERVER) return undefined;
    const entries = promptFileRows.filter((r) => r.name.trim() && r.file);
    return entries.length > 0
      ? Object.fromEntries(entries.map((r) => [r.name.trim(), r.file!]))
      : undefined;
  }, [promptFileRows]);

  const activeProviderKey = providerKeys[selectedProvider];

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<PromptNodeData>) =>
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
      ),
    [setNodes],
  );

  // ── Node change handler ───────────────────────────────────────────────────

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removedIds = new Set(
        changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id),
      );
      if (removedIds.size > 0) {
        setNodePrompts((prev) => {
          const next = { ...prev };
          removedIds.forEach((id) => delete next[id]);
          return next;
        });
        setNodeRefs((prev) => {
          const next = { ...prev };
          removedIds.forEach((id) => delete next[id]);
          return next;
        });
        setSelectedNodeId((prev) => (prev && removedIds.has(prev) ? null : prev));
        markDirty();
      }
      onNodesChange(changes);
    },
    [onNodesChange, markDirty],
  );

  // ── Connect — injects ref() text into the target prompt ───────────────────

  const handleConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return;

      // Validation nodes are sinks: connecting a prompt node → validation node
      // sets the targetModel rather than injecting a ref() call.
      if (targetNode.type === 'validationNode') {
        if (sourceNode.type === 'validationNode') return; // no val→val connections
        const sourceLabel = (sourceNode.data as PromptNodeData).label;
        setNodes((nds) =>
          nds.map((n) =>
            n.id === targetNode.id
              ? { ...n, data: { ...n.data, targetModel: sourceLabel } }
              : n,
          ),
        );
        markDirty();
        return;
      }

      // Validation nodes cannot be sources
      if (sourceNode.type === 'validationNode') return;

      // Standard prompt→prompt connection: inject ref() text
      const refText = `{{ ref('${(sourceNode.data as PromptNodeData).label}') }}`;
      setNodePrompts((prev) => {
        const existing = prev[targetNode.id] ?? '';
        if (existing.includes(refText)) return prev;
        const updated = existing ? `${existing}\n${refText}` : refText;
        setNodeRefs((r) => ({ ...r, [targetNode.id]: extractRefs(updated) }));
        return { ...prev, [targetNode.id]: updated };
      });
      markDirty();
    },
    [nodes, markDirty, setNodes],
  );

  // ── Add node ──────────────────────────────────────────────────────────────

  const openAddDialog = useCallback(() => {
    setAddNodeName('');
    setShowAddDialog(true);
  }, []);

  const confirmAddNode = useCallback(() => {
    const name = addNodeName.trim();
    if (!name) return;
    if (/\s/.test(name)) {
      alert('Model name cannot contain spaces.');
      return;
    }
    if (modelNameSet.has(name)) {
      alert(`A model named "${name}" already exists.`);
      return;
    }
    const id = makeNodeId();
    const rawPos = { x: 200 + Math.random() * 300, y: 150 + Math.random() * 200 };
    const position = rfInstance.current
      ? rfInstance.current.screenToFlowPosition(rawPos)
      : rawPos;

    setNodes((nds) => [
      ...nds,
      {
        id,
        type: 'promptNode',
        position,
        data: { label: name, hasOutput: false, isRunning: false, isTemplate: false, isLoop: false, loopOver: '' } satisfies PromptNodeData,
      },
    ]);
    setNodePrompts((prev) => ({ ...prev, [id]: '' }));
    setNodeRefs((prev) => ({ ...prev, [id]: [] }));
    markDirty();
    setShowAddDialog(false);
  }, [addNodeName, modelNameSet, setNodes, markDirty]);

  const openAddLoopDialog = useCallback(() => {
    setAddLoopNodeName('');
    setShowAddLoopDialog(true);
  }, []);

  const confirmAddLoopNode = useCallback(() => {
    const name = addLoopNodeName.trim();
    if (!name) return;
    if (/\s/.test(name)) {
      alert('Model name cannot contain spaces.');
      return;
    }
    if (modelNameSet.has(name)) {
      alert(`A model named "${name}" already exists.`);
      return;
    }
    const id = makeNodeId();
    const rawPos = { x: 200 + Math.random() * 300, y: 150 + Math.random() * 200 };
    const position = rfInstance.current
      ? rfInstance.current.screenToFlowPosition(rawPos)
      : rawPos;

    setNodes((nds) => [
      ...nds,
      {
        id,
        type: 'promptNode',
        position,
        data: { label: name, hasOutput: false, isRunning: false, isTemplate: false, isLoop: true, loopOver: '' } satisfies PromptNodeData,
      },
    ]);
    setNodePrompts((prev) => ({ ...prev, [id]: '' }));
    setNodeRefs((prev) => ({ ...prev, [id]: [] }));
    markDirty();
    setShowAddLoopDialog(false);
  }, [addLoopNodeName, modelNameSet, setNodes, markDirty]);

  const openAddValidationDialog = useCallback(() => {
    setAddValidationTargetModel(allModelNames[0] ?? '');
    setShowAddValidationDialog(true);
  }, [allModelNames]);

  const confirmAddValidationNode = useCallback(() => {
    const id = makeNodeId();
    const rawPos = { x: 200 + Math.random() * 300, y: 150 + Math.random() * 200 };
    const position = rfInstance.current
      ? rfInstance.current.screenToFlowPosition(rawPos)
      : rawPos;

    setNodes((nds) => [
      ...nds,
      {
        id,
        type: 'validationNode',
        position,
        data: {
          targetModel: addValidationTargetModel,
          properties: [],
        } satisfies ValidationNodeData,
      },
    ]);
    markDirty();
    setShowAddValidationDialog(false);
  }, [addValidationTargetModel, setNodes, markDirty]);

  // ── Node selection (click and double-click share one handler) ─────────────

  const handleNodeSelect = useCallback(
    (_: React.MouseEvent, node: Node) => setSelectedNodeId(node.id),
    [],
  );

  const handlePaneClick = useCallback(() => setSelectedNodeId(null), []);

  // ── Prompt editing ────────────────────────────────────────────────────────

  const handlePromptChange = useCallback(
    (nodeId: string, value: string) => {
      setNodePrompts((prev) => ({ ...prev, [nodeId]: value }));
      setNodeRefs((prev) => ({ ...prev, [nodeId]: extractRefs(value) }));
      markDirty();
    },
    [markDirty],
  );

  const handleRename = useCallback(
    (nodeId: string, newName: string) => {
      if (/\s/.test(newName)) {
        alert('Model name cannot contain spaces.');
        return;
      }
      if (modelNameSet.has(newName)) {
        alert(`A model named "${newName}" already exists.`);
        return;
      }
      updateNodeData(nodeId, { label: newName });
      markDirty();
    },
    [modelNameSet, updateNodeData, markDirty],
  );

  // ── Model run ─────────────────────────────────────────────────────────────

  const runMutation = useMutation({
    mutationFn: ({ modelName }: { modelName: string }) =>
      runDag(
        nodes
          .filter((n) => n.type !== 'validationNode')
          .map((n) => {
            const data = n.data as PromptNodeData;
            let source = nodePrompts[n.id] ?? '';
            if (data.isLoop) {
              const loopConfig = data.loopOver.trim()
                ? `{{ config(model_type="loop", loop_over="${data.loopOver.trim()}") }}\n`
                : `{{ config(model_type="loop") }}\n`;
              source = loopConfig + source;
            }
            return { name: data.label, source, isTemplate: data.isTemplate };
          }),
        [modelName],
        promptDataForApi,
        promptFilesForApi,
        selectedProvider,
        activeProviderKey || undefined,
      ),

    onMutate: ({ modelName }) => {
      const affectedIds = getAncestorIds(modelName, nodes, edges);
      setNodes((nds) =>
        nds.map((n) =>
          affectedIds.has(n.id)
            ? { ...n, data: { ...n.data, isRunning: true } }
            : n,
        ),
      );
    },

    onSuccess: (data) => {
      console.log('[runDag] full response:', JSON.stringify(data, null, 2));
      if (data.errors?.length) {
        console.error('[runDag] errors:', data.errors);
      }
      setNodeOutputs((prev) => ({ ...prev, ...data.outputs }));
      setRunErrors(data.errors);

      const updatedLabels = new Set(Object.keys(data.outputs));
      setNodes((nds) =>
        nds.map((n) => {
          const label = (n.data as PromptNodeData).label;
          if (updatedLabels.has(label))
            return { ...n, data: { ...n.data, isRunning: false, hasOutput: true } };
          if ((n.data as PromptNodeData).isRunning)
            return { ...n, data: { ...n.data, isRunning: false } };
          return n;
        }),
      );
    },

    onError: (err) => {
      console.error('[runDag] mutation error:', err);
      setRunErrors([(err as Error).message]);
      setNodes((nds) =>
        nds.map((n) =>
          (n.data as PromptNodeData).isRunning
            ? { ...n, data: { ...n.data, isRunning: false } }
            : n,
        ),
      );
    },
  });

  const handleRunModel = useCallback(() => {
    if (!selectedNode) return;
    runMutation.mutate({ modelName: (selectedNode.data as PromptNodeData).label });
  }, [selectedNode, runMutation]);

  const handleFileSelected = useCallback((id: string, key: string, file: File) => {
    if (!USE_SERVER) return;
    uploadFileToServer(key, file)
      .then((hash) => {
        setPromptFileRows((rows: PromptFileRow[]) =>
          rows.map((r: PromptFileRow) => (r.id === id ? { ...r, serverHash: hash } : r)),
        );
      })
      .catch((err) => console.error('[pbt] file upload failed:', err));
  }, []);

  // ── Derived panel props ───────────────────────────────────────────────────

  // Validation nodes are self-contained (inline editing); they don't use NodePanel.
  const selectedModelName =
    selectedNode && selectedNode.type !== 'validationNode'
      ? (selectedNode.data as PromptNodeData).label
      : null;

  const isSelectedRunning =
    runMutation.isPending && runMutation.variables?.modelName === selectedModelName;

  const promptDataCount = promptDataRows.filter((r) => r.name.trim()).length;
  const promptFileCount = promptFileRows.filter((r) => r.name.trim() && r.file).length;
  const runtimeReady = USE_SERVER || pyScriptState.status === 'ready';
  const hasPromptFiles = !USE_SERVER && promptFileCount > 0;
  const runDisabledReason = USE_SERVER
    ? undefined
    : !runtimeReady
      ? pyScriptState.message
      : hasPromptFiles
        ? 'Prompt files are not supported by the browser runner yet.'
        : undefined;
  const pyScriptStatusSummary = useMemo(() => {
    if (USE_SERVER) return 'Server mode';
    if (pyScriptState.status === 'ready') return 'PyScript ready';
    return `PyScript: ${pyScriptState.message}`;
  }, [pyScriptState]);
  const pyScriptStatusDetail = USE_SERVER ? 'Running via local server' : pyScriptState.message;

  return (
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <header className="flex items-center gap-2 px-4 py-2 bg-white border-b border-border shadow-sm">
        <span className="font-bold text-foreground tracking-tight mr-2 text-sm">
          PBT DAG Editor
        </span>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="inline-flex w-fit rounded-md border border-border bg-muted/30 p-0.5">
            {PROVIDERS.map((provider) => (
              <Button
                key={provider}
                type="button"
                size="sm"
                variant={selectedProvider === provider ? 'default' : 'ghost'}
                className="h-7 rounded-[5px] px-2.5 font-mono text-[11px] capitalize"
                onClick={() => setSelectedProvider(provider)}
              >
                {provider}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1 flex-1 min-w-0 max-w-md">
            <KeyIcon size={13} className="text-muted-foreground shrink-0" />
            <Input
              type="password"
              value={activeProviderKey}
              onChange={(e) =>
                setProviderKeys((prev) => ({ ...prev, [selectedProvider]: e.target.value }))
              }
              placeholder={`${selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1)} API key`}
              className="h-7 text-xs font-mono"
              spellCheck={false}
            />
          </div>
          <div
            className="max-w-[220px] truncate text-[11px] text-muted-foreground"
            title={pyScriptStatusDetail}
          >
            {pyScriptStatusSummary}
          </div>
        </div>

        {/* Right-side manager + action buttons */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDataManager(true)}
          title="Manage promptdata() variables"
        >
          <DatabaseIcon size={13} />
          Prompt Data
          {promptDataCount > 0 && (
            <span className="ml-1 bg-primary text-primary-foreground rounded-full text-[10px] px-1.5 leading-none">
              {promptDataCount}
            </span>
          )}
        </Button>

        {USE_SERVER && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFileManager(true)}
            title="Manage promptfiles uploads"
          >
            <FileIcon size={13} />
            Prompt Files
            {promptFileCount > 0 && (
              <span className="ml-1 bg-primary text-primary-foreground rounded-full text-[10px] px-1.5 leading-none">
                {promptFileCount}
              </span>
            )}
          </Button>
        )}

        <Button size="sm" onClick={openAddDialog}>
          <PlusIcon size={13} />
          Add node
        </Button>

        <Button size="sm" variant="outline" onClick={openAddLoopDialog}>
          <RepeatIcon size={13} />
          Loop node
        </Button>

        <Button size="sm" variant="outline" onClick={openAddValidationDialog}>
          <ShieldCheckIcon size={13} />
          Validate
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              Model
              <ChevronDownIcon size={13} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleExport()}>
              <DownloadIcon size={13} />
              Export — copy to clipboard
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleExportPython()}>
              <DownloadIcon size={13} />
              Export to Python — copy to clipboard
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleImport()}>
              <UploadIcon size={13} />
              Import — paste from clipboard
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* ── Main content ── */}
      <div className="flex flex-1 min-h-0">
        {/* React Flow canvas */}
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onConnect={handleConnect}
            onConnectEnd={handleConnectEnd}
            onNodeClick={handleNodeSelect}
            onNodeDoubleClick={handleNodeSelect}
            onPaneClick={handlePaneClick}
            onInit={(instance) => { rfInstance.current = instance; }}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            deleteKeyCode={["Delete", "Backspace"]}
            minZoom={0.2}
            maxZoom={3}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e2e8f0" />
            <Controls />
            <MiniMap
              nodeColor={() => '#e2e8f0'}
              maskColor="rgba(248,250,252,0.7)"
              className="border border-border rounded-lg"
            />
          </ReactFlow>
        </div>

        {/* Node panel — key resets all local state when selected node changes,
            eliminating the need for useEffect-based draftName sync */}
        {selectedNode && selectedModelName && (
          <>
            <div
              className="w-1 cursor-col-resize hover:bg-blue-400 bg-border transition-colors flex-shrink-0"
              onMouseDown={handlePanelDragStart}
            />
            <div style={{ width: panelWidth }} className="flex-shrink-0 min-h-0 h-full overflow-hidden">
              <NodePanel
                key={selectedNode.id}
                nodeName={selectedModelName}
                prompt={nodePrompts[selectedNode.id] ?? ''}
                output={nodeOutputs[selectedModelName]}
                errors={runErrors}
                isRunning={isSelectedRunning}
                isRunDisabled={!runtimeReady || (!USE_SERVER && hasPromptFiles)}
                runDisabledReason={runDisabledReason}
                isTemplate={(selectedNode.data as PromptNodeData).isTemplate}
                isLoop={(selectedNode.data as PromptNodeData).isLoop}
                loopOver={(selectedNode.data as PromptNodeData).loopOver}
                otherNodeNames={otherNodeNames}
                promptDataNames={promptDataRows.filter(r => r.name.trim()).map(r => r.name.trim())}
                promptFileNames={USE_SERVER ? promptFileRows.filter(r => r.name.trim()).map(r => r.name.trim()) : []}
                onPromptChange={(value) => handlePromptChange(selectedNode.id, value)}
                onRename={(newName) => handleRename(selectedNode.id, newName)}
                onTemplateChange={(value) => {
                  updateNodeData(selectedNode.id, { isTemplate: value });
                  markDirty();
                }}
                onLoopOverChange={(value) => {
                  updateNodeData(selectedNode.id, { loopOver: value });
                  markDirty();
                }}
                onClose={() => setSelectedNodeId(null)}
                onRun={handleRunModel}
              />
            </div>
          </>
        )}
      </div>

      {/* ── Add node dialog ── */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add model node</DialogTitle>
            <DialogDescription>
              Create a new inline prompt model in the browser DAG.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="block text-sm text-muted-foreground mb-1.5">Model name</label>
            <Input
              autoFocus
              value={addNodeName}
              onChange={(e) => setAddNodeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAddNode(); }}
              placeholder="e.g. article, summary, tweet"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Lowercase letters, digits, and underscores only.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button onClick={confirmAddNode} disabled={!addNodeName.trim()}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add loop node dialog ── */}
      <Dialog open={showAddLoopDialog} onOpenChange={setShowAddLoopDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add loop node</DialogTitle>
            <DialogDescription>
              A loop node iterates over each item in a JSON array from an upstream node and produces a combined JSON array as output.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="block text-sm text-muted-foreground mb-1.5">Model name</label>
            <Input
              autoFocus
              value={addLoopNodeName}
              onChange={(e) => setAddLoopNodeName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAddLoopNode(); }}
              placeholder="e.g. processed_items"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Lowercase letters, digits, and underscores only.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddLoopDialog(false)}>Cancel</Button>
            <Button onClick={confirmAddLoopNode} disabled={!addLoopNodeName.trim()}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add validation node dialog ── */}
      <Dialog open={showAddValidationDialog} onOpenChange={setShowAddValidationDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add validation node</DialogTitle>
            <DialogDescription>
              Define a Pydantic schema to validate a model's output. You can also connect a
              model node to an existing validation node after creation.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="block text-sm text-muted-foreground mb-1.5">
              Model to validate
            </label>
            {allModelNames.length > 0 ? (
              <select
                value={addValidationTargetModel}
                onChange={(e) => setAddValidationTargetModel(e.target.value)}
                className="w-full text-sm border border-border rounded px-2 py-1.5 bg-background"
              >
                <option value="">— connect after creation —</option>
                {allModelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">
                No models yet. Add a model node first, or create the validation node and
                connect it later by dragging.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddValidationDialog(false)}>
              Cancel
            </Button>
            <Button onClick={confirmAddValidationNode}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Manager dialogs ── */}
      <PromptDataManager
        open={showDataManager}
        onOpenChange={setShowDataManager}
        rows={promptDataRows}
        onRowsChange={setPromptDataRows}
      />
      {USE_SERVER && (
        <PromptFileManager
          open={showFileManager}
          onOpenChange={setShowFileManager}
          rows={promptFileRows}
          onRowsChange={setPromptFileRows}
          onFileSelected={handleFileSelected}
        />
      )}
    </div>
  );
}
