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

export const SERVER_URL_STORAGE = 'wm.serverUrl';

/**
 * Where the runner lives. Priority:
 *   1. a URL saved in the toolbar (localStorage) — lets a deployed/preview
 *      build point at Railway with no rebuild;
 *   2. the `VITE_SERVER_URL` build-time env;
 *   3. `/api`, which the Vite dev server proxies to localhost:8000.
 *
 * A 405 usually means requests hit a static host (GitHub Pages, `vite preview`)
 * instead of the server — set the URL here to fix it.
 */
export function getServerUrl(): string {
  const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(SERVER_URL_STORAGE)) || '';
  const envUrl = (import.meta as any).env?.VITE_SERVER_URL || '';
  return (saved || envUrl || '/api').replace(/\/+$/, '');
}

export async function runGraph(
  nodes: NodePayload[],
  provider: Provider,
  apiKey: string | undefined,
): Promise<RunResponse> {
  const url = `${getServerUrl()}/run`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes, provider, apiKey: apiKey || undefined }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the server at ${url} (${err instanceof Error ? err.message : String(err)}). ` +
        `Set the server URL from the ⚙ toolbar button.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 405
        ? ' — that URL is not the runner (a static host answered). Set the server URL from the ⚙ toolbar button.'
        : '';
    throw new Error(`Server ${res.status} ${res.statusText} at ${url}${hint} ${body.slice(0, 200)}`.trim());
  }
  return res.json();
}
