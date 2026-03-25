import type { Node } from '@xyflow/react';
import type { LlmProvider } from '../api';
import type { PromptDataRow } from '../components/PromptDataManager';
import type { PromptFileRow } from '../components/PromptFileManager';

const REF_RE = /ref\(['"]([^'"]+)['"]\)/g;

function extractRefs(source: string): string[] {
  return [...new Set([...source.matchAll(REF_RE)].map((m) => m[1]))];
}

export interface UserModelState {
  version: 1;
  selectedProvider: LlmProvider;
  nodes: Node[];
  nodePrompts: Record<string, string>;
  nodeRefs: Record<string, string[]>;
  promptDataRows: PromptDataRow[];
  promptFileRows: Omit<PromptFileRow, 'file'>[];
  nodeOutputs: Record<string, string>;
}

export interface HydratedUserModelState {
  selectedProvider: LlmProvider;
  nodes: Node[];
  nodePrompts: Record<string, string>;
  nodeRefs: Record<string, string[]>;
  promptDataRows: PromptDataRow[];
  promptFileRows: PromptFileRow[];
  nodeOutputs: Record<string, string>;
}

export async function buildUserModelState(params: {
  selectedProvider: LlmProvider;
  nodes: Node[];
  nodePrompts: Record<string, string>;
  promptDataRows: PromptDataRow[];
  promptFileRows: PromptFileRow[];
  nodeOutputs: Record<string, string>;
}): Promise<UserModelState> {
  const nodeRefs: Record<string, string[]> = {};
  for (const [id, prompt] of Object.entries(params.nodePrompts)) {
    nodeRefs[id] = extractRefs(prompt);
  }

  return {
    version: 1,
    selectedProvider: params.selectedProvider,
    nodes: params.nodes,
    nodePrompts: params.nodePrompts,
    nodeRefs,
    promptDataRows: params.promptDataRows,
    // File objects can't be JSON-serialised — strip them
    promptFileRows: params.promptFileRows.map(({ file: _f, ...rest }) => rest),
    nodeOutputs: params.nodeOutputs,
  };
}

export function hydrateUserModelState(state: UserModelState): HydratedUserModelState {
  return {
    selectedProvider: state.selectedProvider,
    nodes: state.nodes ?? [],
    nodePrompts: state.nodePrompts ?? {},
    nodeRefs: state.nodeRefs ?? {},
    promptDataRows: state.promptDataRows ?? [],
    promptFileRows: (state.promptFileRows ?? []).map((r) => ({ ...r, file: null })),
    nodeOutputs: state.nodeOutputs ?? {},
  };
}
