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
 * Grab a server URL from the page's own address, e.g.
 * `https://my-frontend/?server=https://app.up.railway.app`, and remember it.
 * Call once at startup — this is the "grab the URL through JavaScript" path, so
 * a deployed frontend can be pointed at its server with just a link, no typing.
 */
export function initServerUrlFromQuery(): void {
  try {
    const q = new URLSearchParams(window.location.search);
    const url = q.get('server') || q.get('api');
    if (url) localStorage.setItem(SERVER_URL_STORAGE, url.trim());
  } catch {
    /* no window / blocked storage — ignore */
  }
}

/**
 * Where the runner lives, resolved in JavaScript. Priority:
 *   1. a URL saved in the toolbar or grabbed from `?server=` (localStorage);
 *   2. the `VITE_SERVER_URL` build-time env;
 *   3. dev → `/api` (Vite proxies it to localhost:8000);
 *   4. production → the current page's own origin, so a frontend served by the
 *      server posts to that same URL with no configuration.
 *
 * A 405 usually means requests hit a static host (GitHub Pages, `vite preview`)
 * that isn't the server — override with `?server=…` or `VITE_SERVER_URL`.
 */
export function getServerUrl(): string {
  const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(SERVER_URL_STORAGE)) || '';
  const envUrl = (import.meta as any).env?.VITE_SERVER_URL || '';
  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const fallback = (import.meta as any).env?.DEV ? '/api' : pageOrigin;
  return (saved || envUrl || fallback).replace(/\/+$/, '');
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
      `Could not reach the server at ${url} (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 405 ? ' — that URL is not the runner (a static host answered).' : '';
    throw new Error(`Server ${res.status} ${res.statusText} at ${url}${hint} ${body.slice(0, 200)}`.trim());
  }
  return res.json();
}
