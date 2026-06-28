import type { Node } from '@xyflow/react';
import type { PromptNodeData } from '@/components/PromptNode';
import type { PromptDataRow } from '@/components/PromptDataManager';
import type { PromptFileRow } from '@/components/PromptFileManager';
import type { LlmProvider } from '@/api';

export interface UserModelStateNode {
  id: string;
  position: Node['position'];
  label: string;
  isTemplate: boolean;
  isLoop: boolean;
}

export interface UserModelStatePromptDataRow {
  id: string;
  name: string;
  value: string;
}

export interface UserModelStatePromptFile {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface UserModelState {
  version: 1;
  selectedProvider: LlmProvider;
  nodes: UserModelStateNode[];
  nodePrompts: Record<string, string>;
  promptDataRows: UserModelStatePromptDataRow[];
  promptFiles: UserModelStatePromptFile[];
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

const REF_RE = /ref\(['"]([^'"]+)['"]\)/g;

function extractRefs(source: string): string[] {
  return [...new Set([...source.matchAll(REF_RE)].map((m) => m[1]))];
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function buildUserModelState(params: {
  selectedProvider: LlmProvider;
  nodes: Node[];
  nodePrompts: Record<string, string>;
  promptDataRows: PromptDataRow[];
  promptFileRows: PromptFileRow[];
  nodeOutputs: Record<string, string>;
}): Promise<UserModelState> {
  const promptFiles = await Promise.all(
    params.promptFileRows
      .filter((row) => row.name.trim() && row.file)
      .map(async (row) => ({
        id: row.id,
        name: row.name,
        fileName: row.file!.name,
        mimeType: row.file!.type || 'application/octet-stream',
        dataBase64: arrayBufferToBase64(await row.file!.arrayBuffer()),
      })),
  );

  return {
    version: 1,
    selectedProvider: params.selectedProvider,
    nodes: params.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      label: (node.data as PromptNodeData).label,
      isTemplate: (node.data as PromptNodeData).isTemplate,
      isLoop: (node.data as PromptNodeData).isLoop,
    })),
    nodePrompts: params.nodePrompts,
    nodeOutputs: params.nodeOutputs,
    promptDataRows: params.promptDataRows.map((row) => ({
      id: row.id,
      name: row.name,
      value: row.value,
    })),
    promptFiles,
  };
}

export function hydrateUserModelState(state: UserModelState): HydratedUserModelState {
  const nodeOutputs = state.nodeOutputs ?? {};
  return {
    selectedProvider: state.selectedProvider,
    nodes: state.nodes.map((node) => ({
      id: node.id,
      type: 'promptNode',
      position: node.position,
      data: {
        label: node.label,
        hasOutput: Boolean(nodeOutputs[node.label]),
        isRunning: false,
        isTemplate: node.isTemplate,
        isLoop: node.isLoop ?? false,
      } satisfies PromptNodeData,
    })),
    nodePrompts: state.nodePrompts,
    nodeOutputs,
    nodeRefs: Object.fromEntries(
      state.nodes.map((node) => [node.id, extractRefs(state.nodePrompts[node.id] ?? '')]),
    ),
    promptDataRows: state.promptDataRows.map((row) => ({ ...row })),
    promptFileRows: state.promptFiles.map((row) => ({
      id: row.id,
      name: row.name,
      file: new File([base64ToArrayBuffer(row.dataBase64)], row.fileName, { type: row.mimeType }),
    })),
  };
}
