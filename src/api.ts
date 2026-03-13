import { runDagInPyScript } from './lib/pyscriptBridge';

/** Set to true to send DAG runs to the local server instead of PyScript. */
// export const USE_SERVER = false;
export const USE_SERVER = true;

/** Server base path — proxied by Vite to http://localhost:8000 via the /api rewrite. */
const SERVER_URL = '/api';

export interface DagNodePayload {
  name: string;
  source: string;
  isTemplate?: boolean;
}

export type LlmProvider = 'gemini' | 'openai' | 'anthropic';

export interface RunResponse {
  outputs: Record<string, string>;
  errors: string[];
}

/** Persistent session ID for pre-uploaded files. Survives page refresh. */
export function getSessionId(): string {
  let id = localStorage.getItem('pbt_session_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('pbt_session_id', id);
  }
  return id;
}

/**
 * Upload a single file to server session storage. The file is stored by
 * content hash so re-uploading the same bytes is a no-op on disk.
 * Returns the 16-char hash assigned by the server.
 */
export async function uploadFileToServer(key: string, file: File): Promise<string> {
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
  const form = new FormData();
  form.append('session_id', getSessionId());
  form.append('files', file, key + ext);
  const res = await fetch(`${SERVER_URL}/files/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.uploaded[key + ext] as string;
}

async function runDagOnServer(
  nodes: DagNodePayload[],
  select?: string[],
  promptdata?: Record<string, string>,
  provider: LlmProvider = 'gemini',
  apiKey?: string,
): Promise<RunResponse> {
  const form = new FormData();
  form.append('nodes', JSON.stringify(nodes));
  if (select?.length) select.forEach(s => form.append('select', s));
  if (promptdata) form.append('promptdata', JSON.stringify(promptdata));
  form.append('session_id', getSessionId());
  form.append('provider', provider);
  if (apiKey) form.append('api_key', apiKey);

  const res = await fetch(`${SERVER_URL}/dag/run`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Server error: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Run a DAG via PyScript (browser) or the local server, depending on USE_SERVER.
 * In server mode, files are expected to have been pre-uploaded via uploadFileToServer;
 * they are resolved on the server by session ID rather than sent with each run.
 */
export async function runDag(
  nodes: DagNodePayload[],
  select?: string[],
  promptdata?: Record<string, string>,
  promptfiles?: Record<string, File>,
  provider: LlmProvider = 'gemini',
  apiKey?: string,
): Promise<RunResponse> {
  if (USE_SERVER) {
    return runDagOnServer(nodes, select, promptdata, provider, apiKey);
  }
  return runDagInPyScript({ nodes, select, promptdata, promptfiles, provider, apiKey });
}
