/**
 * A per-browser session id, used to namespace uploaded files.
 *
 * Files live under `sessions/<sessionId>/…` in the bucket, and the server will
 * only return, sign or attach a key that sits under the session that asked for
 * it. The id is a 32-character `nanoid` — unguessable in practice — kept in
 * localStorage so a reload keeps its files.
 *
 * Be clear about what this is: a bearer secret, not an account. Anyone holding
 * the id can reach that session's files, and clearing site data loses them.
 */
import { nanoid } from 'nanoid';

const SESSION_KEY = 'wm.session';

let cached: string | null = null;

export function getSessionId(): string {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved && /^[A-Za-z0-9_-]{16,}$/.test(saved)) {
      cached = saved;
      return saved;
    }
    const fresh = nanoid(32);
    localStorage.setItem(SESSION_KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // Storage blocked: still give this page load a usable id.
    cached = cached ?? nanoid(32);
    return cached;
  }
}
