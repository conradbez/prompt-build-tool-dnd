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

import type { BulletKind, FileRef } from './types';
import { getSessionId } from './lib/session';

export interface NodePayload {
  id: string;
  /** The bullet's markdown text, with `@` mentions expanded to full titles. */
  text: string;
  parentId: string | null;
  refs: string[];
  /** Prompt, template, or python — decides how the server runs it. */
  kind: BulletKind;
  /** Attachments, sent to the model along with this bullet's prompt. */
  files: FileRef[];
}

export interface RunResponse {
  outputs: Record<string, string>;
  /** The prompt each bullet was actually sent, keyed the same way. */
  prompts: Record<string, string>;
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

/** Whether the server can run `python` bullets (Modal configured). */
export async function pythonEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${getServerUrl()}/python/enabled`);
    if (!res.ok) return false;
    return !!(await res.json()).enabled;
  } catch {
    return false;
  }
}

/** Whether the server has a bucket configured; uploads are hidden if not. */
export async function filesEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${getServerUrl()}/files/enabled`);
    if (!res.ok) return false;
    return !!(await res.json()).enabled;
  } catch {
    return false;
  }
}

/** Upload one file and get back the reference to store on the bullet. */
export async function uploadFile(bulletId: string, file: File): Promise<FileRef> {
  const body = new FormData();
  body.append('sessionId', getSessionId());
  body.append('bulletId', bulletId);
  body.append('file', file);
  const res = await fetch(`${getServerUrl()}/files`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return { key: data.key, name: data.name };
}

/**
 * Ask for a short-lived download link. The server signs it only for keys
 * belonging to this session, and the bytes then come straight from the bucket.
 */
export async function fileLink(file: FileRef): Promise<string> {
  const res = await fetch(`${getServerUrl()}/files/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...file, sessionId: getSessionId() }),
  });
  if (!res.ok) throw new Error(`Could not get a link: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.url as string;
}

/** Remove the stored object. Best-effort: the bullet drops it either way. */
export async function deleteFile(key: string): Promise<void> {
  await fetch(`${getServerUrl()}/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, sessionId: getSessionId() }),
  }).catch(() => undefined);
}

export async function runGraph(
  nodes: NodePayload[],
  provider: Provider,
  apiKey: string | undefined,
  /** Settings → prepended to every LLM call the run makes. */
  globalInstruction?: string,
  /** Settings → run variables. Each `@name` in a bullet reads one of these. */
  promptdata?: Record<string, string>,
): Promise<RunResponse> {
  const url = `${getServerUrl()}/run`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        nodes,
        provider,
        apiKey: apiKey || undefined,
        sessionId: getSessionId(),
        globalInstruction: globalInstruction || '',
        promptdata: promptdata || {},
      }),
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
