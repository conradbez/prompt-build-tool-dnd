import { runDagInPyScript } from './lib/pyscriptBridge';

/** Set to true to send DAG runs to the local server instead of PyScript. */
export const USE_SERVER = false;

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

async function runDagOnServer(
  nodes: DagNodePayload[],
  select?: string[],
  promptdata?: Record<string, string>,
  promptfiles?: Record<string, File>,
  provider: LlmProvider = 'gemini',
  apiKey?: string,
): Promise<RunResponse> {
  const form = new FormData();
  form.append('nodes', JSON.stringify(nodes));
  if (select?.length) select.forEach(s => form.append('select', s));
  if (promptdata) form.append('promptdata', JSON.stringify(promptdata));
  if (promptfiles) {
    Object.entries(promptfiles).forEach(([key, file]) => {
      const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
      form.append('promptfiles', file, key + ext);
    });
  }
  form.append('provider', provider);
  if (apiKey) form.append('api_key', apiKey);

  const res = await fetch(`${SERVER_URL}/dag/run`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Server error: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Run a DAG via PyScript (browser) or the local server, depending on USE_SERVER.
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
    return runDagOnServer(nodes, select, promptdata, promptfiles, provider, apiKey);
  }
  return runDagInPyScript({ nodes, select, promptdata, promptfiles, provider, apiKey });
}
