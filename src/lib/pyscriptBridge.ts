import type { DagNodePayload, RunResponse } from '../api';

export interface PyScriptBridgeState {
  status: 'loading' | 'ready' | 'error';
  message: string;
}

let _state: PyScriptBridgeState = { status: 'loading', message: 'Loading PyScript runtime…' };
const _listeners = new Set<(s: PyScriptBridgeState) => void>();

export function getPyScriptBridgeState(): PyScriptBridgeState {
  return _state;
}

export function subscribePyScriptBridgeState(fn: (s: PyScriptBridgeState) => void): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

function _notify(state: PyScriptBridgeState): void {
  _state = state;
  _listeners.forEach((fn) => fn(state));
}

export function initializePyScript(): void {
  window.addEventListener('pbt:pyscript-status', (e: Event) => {
    const detail = (e as CustomEvent<{ message: string }>).detail;
    const msg = detail?.message ?? '';
    const lower = msg.toLowerCase();
    if (lower.includes('ready')) {
      _notify({ status: 'ready', message: msg });
    } else if (lower.includes('failed') || lower.includes('error')) {
      _notify({ status: 'error', message: msg });
    } else {
      _notify({ status: 'loading', message: msg });
    }
  });
}

export async function runDagInPyScript(payload: {
  nodes: DagNodePayload[];
  select?: string[];
  promptdata?: Record<string, string>;
  promptfiles?: Record<string, File>;
  provider: string;
  apiKey?: string;
}): Promise<RunResponse> {
  const bridge = (window as unknown as Record<string, unknown>).__pbtPyBridge as
    | { runDag: (json: string) => Promise<string> }
    | undefined;
  if (!bridge?.runDag) {
    throw new Error('PyScript bridge not ready. Wait for the runtime to load or use server mode.');
  }
  const raw = await bridge.runDag(JSON.stringify(payload));
  return JSON.parse(raw) as RunResponse;
}
