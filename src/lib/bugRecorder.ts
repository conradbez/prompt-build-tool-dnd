/**
 * Records the page with rrweb so a bug report can carry a replay of the last
 * few minutes (see `server/bug_reports.py`).
 *
 * rrweb's events only replay from a full snapshot, so the recording is cut into
 * segments: every `CHECKOUT_MS` it takes a fresh snapshot and starts a new one.
 * Old segments are dropped once the ones after them already reach back
 * `KEEP_MS`, so a report holds between `KEEP_MS` and `KEEP_MS + CHECKOUT_MS`.
 * Password inputs are masked (rrweb's default).
 */

import { record, type eventWithTime } from 'rrweb';

import { getServerUrl } from '../api';
import { getAccount } from './account';

const KEEP_MS = 180_000;
const CHECKOUT_MS = 30_000;

let segments: eventWithTime[][] = [];
let started = false;

export function startBugRecorder(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  try {
    record({
      emit(event, isCheckout) {
        if (isCheckout || segments.length === 0) segments.push([]);
        segments[segments.length - 1].push(event);
        if (isCheckout) prune(event.timestamp);
      },
      checkoutEveryNms: CHECKOUT_MS,
      // Mouse moves are the bulk of a recording; this keeps them smooth enough.
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
      maskInputOptions: { password: true },
    });
  } catch (e) {
    console.warn('Bug recorder could not start:', e);
  }
}

/** Drop the oldest segments while the rest still reach back `KEEP_MS`. */
function prune(now: number): void {
  while (segments.length > 1 && segments[1][0].timestamp <= now - KEEP_MS) segments.shift();
}

/** The buffered recording, oldest first. */
export function recentEvents(): eventWithTime[] {
  const last = segments[segments.length - 1]?.at(-1);
  if (last) prune(last.timestamp);
  return segments.flat();
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function sendBugReport(description: string, events: eventWithTime[]): Promise<number> {
  const form = new FormData();
  form.append('description', description);
  form.append('url', location.href);
  form.append('userAgent', navigator.userAgent);
  form.append('events', await gzip(JSON.stringify(events)), 'events.json.gz');
  const account = getAccount();
  const res = await fetch(`${getServerUrl()}/bug-reports`, {
    method: 'POST',
    body: form,
    headers: account ? { Authorization: `Bearer ${account.token}` } : {},
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = String(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()).id;
}
