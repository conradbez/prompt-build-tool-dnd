/** API client for the pbt server (proxied through Vite at /api → localhost:8000) */

const BASE = '/api';

export interface DagNodePayload {
  name: string;
  source: string;
}

export interface RunResponse {
  outputs: Record<string, string>;
  errors: string[];
}

/**
 * Build and run a DAG inline — nodes, select, promptdata and promptfiles in one request.
 * Sent as multipart/form-data so promptfiles (File objects) can be included.
 */
export async function runDag(
  nodes: DagNodePayload[],
  select?: string[],
  promptdata?: Record<string, string>,
  promptfiles?: Record<string, File>,
  geminiKey?: string,
): Promise<RunResponse> {
  const form = new FormData();
  form.append('nodes', JSON.stringify(nodes));
  if (geminiKey) form.append('gemini_key', geminiKey);
  select?.forEach((s) => form.append('select', s));
  if (promptdata && Object.keys(promptdata).length > 0) {
    form.append('promptdata', JSON.stringify(promptdata));
  }
  if (promptfiles) {
    for (const [name, file] of Object.entries(promptfiles)) {
      form.append('promptfiles', file, name);
    }
  }
  const res = await fetch(`${BASE}/dag/run`, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /dag/run failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<RunResponse>;
}
