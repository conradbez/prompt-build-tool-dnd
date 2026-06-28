export interface DagNodePayloadLike {
  name: string;
  source: string;
  isTemplate?: boolean;
}

export interface PyScriptRunResponse {
  outputs: Record<string, string>;
  errors: string[];
}

export type PyScriptBridgeStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PyScriptBridgeState {
  status: PyScriptBridgeStatus;
  message: string;
}

interface PyScriptBridge {
  runDag: (payloadJson: string) => Promise<string> | string;
}

declare global {
  interface Window {
    __pbtPyBridge?: PyScriptBridge;
    __pbtPyBridgeError?: string;
  }
}

const BRIDGE_WAIT_TIMEOUT_MS = 30000;
const BRIDGE_WAIT_INTERVAL_MS = 100;

let state: PyScriptBridgeState = {
  status: 'idle',
  message: 'PyScript not started.',
};

let didInit = false;
let readyPromise: Promise<void> | null = null;
const listeners = new Set<(next: PyScriptBridgeState) => void>();

function emit(next: Partial<PyScriptBridgeState>) {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener(state);
  }
}

function getBridge(): PyScriptBridge | undefined {
  return window.__pbtPyBridge;
}

function waitForBridge(): Promise<void> {
  if (readyPromise) {
    return readyPromise;
  }

  readyPromise = new Promise((resolve, reject) => {
    const existing = getBridge();
    if (existing) {
      emit({
        status: 'ready',
        message: 'PyScript runtime ready.',
      });
      resolve();
      return;
    }

    const startedAt = Date.now();

    const handleStatus = (event: Event) => {
      const customEvent = event as CustomEvent<{ message?: string }>;
      const message = customEvent.detail?.message;
      if (message) {
        emit({ status: 'loading', message });
      }
    };

    const cleanup = () => {
      window.removeEventListener('pbt:pyscript-status', handleStatus as EventListener);
    };

    const poll = () => {
      if (window.__pbtPyBridgeError) {
        cleanup();
        const error = new Error(window.__pbtPyBridgeError);
        emit({ status: 'error', message: error.message });
        reject(error);
        return;
      }

      const bridge = getBridge();
      if (bridge) {
        cleanup();
        emit({
          status: 'ready',
          message: 'PyScript runtime ready.',
        });
        resolve();
        return;
      }

      if (Date.now() - startedAt >= BRIDGE_WAIT_TIMEOUT_MS) {
        cleanup();
        const error = new Error('Timed out waiting for the PyScript bridge.');
        emit({ status: 'error', message: error.message });
        reject(error);
        return;
      }

      window.setTimeout(poll, BRIDGE_WAIT_INTERVAL_MS);
    };

    window.addEventListener('pbt:pyscript-status', handleStatus as EventListener);
    poll();
  });

  return readyPromise;
}

function installScriptErrorHandler() {
  const coreScript = document.querySelector<HTMLScriptElement>('script[data-pyscript-core]');
  if (!coreScript) {
    emit({ status: 'error', message: 'PyScript core script tag was not found.' });
    return;
  }

  coreScript.addEventListener('error', () => {
    emit({ status: 'error', message: 'Failed to load PyScript core.' });
  });
}

export function initializePyScript() {
  if (typeof window === 'undefined' || didInit) {
    return;
  }

  didInit = true;
  window.__pbtPyBridgeError = undefined;
  emit({ status: 'loading', message: 'Loading PyScript runtime…' });
  installScriptErrorHandler();

  window.addEventListener('py:ready', () => {
    emit({ status: 'loading', message: 'PyScript loaded. Initializing bridge…' });
    void waitForBridge();
  }, { once: true });

  if (getBridge()) {
    void waitForBridge();
  }
}

export function subscribePyScriptBridgeState(listener: (next: PyScriptBridgeState) => void) {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export function getPyScriptBridgeState() {
  return state;
}

export async function runDagInPyScript(params: {
  nodes: DagNodePayloadLike[];
  select?: string[];
  promptdata?: Record<string, string>;
  promptfiles?: Record<string, File>;
  provider: string;
  apiKey?: string;
}): Promise<PyScriptRunResponse> {
  initializePyScript();
  await waitForBridge();

  const bridge = getBridge();
  if (!bridge) {
    throw new Error('PyScript bridge was not initialized.');
  }

  if (params.promptfiles && Object.keys(params.promptfiles).length > 0) {
    throw new Error('Prompt files are not supported by the browser runner yet.');
  }

  const payloadJson = JSON.stringify({
    nodes: params.nodes,
    select: params.select,
    promptdata: params.promptdata,
    provider: params.provider,
    apiKey: params.apiKey,
  });

  const raw = await bridge.runDag(payloadJson);
  return JSON.parse(raw) as PyScriptRunResponse;
}
