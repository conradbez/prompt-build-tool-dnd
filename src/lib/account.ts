/**
 * Who is signed in, and the server's calls for it — see `server/accounts.py`.
 *
 * Signing in is optional. The token is a bearer token kept in this browser;
 * once there, named saves go to the server instead (see `lib/saves`).
 */

import { useSyncExternalStore } from 'react';

import { getServerUrl } from '../api';
import type { Doc } from '../store';

const STORAGE_KEY = 'wm.account';

export interface Account {
  email: string;
  token: string;
}

export interface MapList {
  maps: { name: string; updated: number; rev: number }[];
  current: { name: string; doc: unknown; updated: number; rev: number } | null;
}

/** A save refused because the map was saved elsewhere since — see `putMap`. */
export class MapConflict extends Error {
  constructor(
    message: string,
    /** The map's revision on the server now. */
    readonly rev: number,
  ) {
    super(message);
  }
}

let account: Account | null = read();
const listeners = new Set<() => void>();

function read(): Account | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return v && typeof v.email === 'string' && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

function set(next: Account | null) {
  account = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* held for this page load */
  }
  listeners.forEach((l) => l());
}

export function getAccount(): Account | null {
  return account;
}

export function subscribeAccount(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAccount(): Account | null {
  return useSyncExternalStore(subscribeAccount, getAccount, getAccount);
}

/** The server's `detail`, or a line about the status. */
async function fail(res: Response): Promise<never> {
  let detail = '';
  try {
    detail = (await res.json()).detail;
  } catch {
    /* not JSON */
  }
  throw new Error(typeof detail === 'string' && detail ? detail : `The server answered ${res.status}.`);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (account) headers.Authorization = `Bearer ${account.token}`;
  const res = await fetch(`${getServerUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && account) set(null);
  if (!res.ok) return fail(res);
  return res.json();
}

/** Email a one-time code to *email*. */
export async function requestCode(email: string): Promise<void> {
  await call('POST', '/auth/code', { email });
}

/** Trade the emailed code for a session; the account is signed in on success. */
export async function verifyCode(email: string, code: string): Promise<Account> {
  const next = await call<Account>('POST', '/auth/verify', { email, code });
  set({ email: next.email, token: next.token });
  return next;
}

export async function signOut(): Promise<void> {
  try {
    await call('POST', '/auth/logout');
  } catch {
    /* signed out here either way */
  }
  set(null);
}

/** The maps on the server, and one in full: *name*'s, or the one saved last. */
export function fetchMaps(name?: string): Promise<MapList> {
  return call('GET', name === undefined ? '/maps' : `/maps?name=${encodeURIComponent(name)}`);
}

/**
 * Store *doc* as *name*, based on revision *rev* — the server refuses it with a
 * `MapConflict` when the map has been saved since. Without *rev* it overwrites.
 * Resolves to the map's new revision.
 *
 * *keepalive* lets the request outlive the page, for the save made as it
 * closes; browsers cap such a body at 64 KB, past which it is simply not sent.
 */
export async function putMap(
  name: string,
  doc: Doc,
  rev?: number,
  keepalive = false,
): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (account) headers.Authorization = `Bearer ${account.token}`;
  const res = await fetch(`${getServerUrl()}/maps`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name, doc, rev }),
    keepalive,
  });
  if (res.status === 409) {
    const detail = (await res.json().catch(() => ({})))?.detail ?? {};
    throw new MapConflict(String(detail.message ?? 'Saved somewhere else since.'), Number(detail.rev) || 0);
  }
  if (res.status === 401 && account) set(null);
  if (!res.ok) return fail(res);
  return (await res.json()).rev;
}
