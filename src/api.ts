/**
 * Thin client for the mind-map runner (see `server/`). One call: send the
 * bullet graph, get each bullet's result back after flowing through pbt.
 */

export type Provider = 'gemini' | 'openai' | 'anthropic';

export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
];

export interface NodePayload {
  id: string;
  title: string;
  body: string;
  refs: string[];
}

export interface RunResponse {
  outputs: Record<string, string>;
  errors: string[];
}

/**
 * Base URL for the server. In dev, Vite proxies `/api` → localhost:8000.
 * For a deployed build, set `VITE_SERVER_URL` to the Railway URL.
 */
const SERVER_URL = (import.meta as any).env?.VITE_SERVER_URL || '/api';

export async function runGraph(
  nodes: NodePayload[],
  provider: Provider,
  apiKey: string | undefined,
): Promise<RunResponse> {
  const res = await fetch(`${SERVER_URL}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, provider, apiKey: apiKey || undefined }),
  });
  if (!res.ok) {
    throw new Error(`Server error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
