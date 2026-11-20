/**
 * Bug reports, client side: a rolling rrweb recording of the last ~180s plus
 * recent console errors and failed requests, sent on demand to
 * `server/bug_reports.py`. Self-contained — nothing else in the app uses it.
 */
import { record, type eventWithTime } from 'rrweb';
import { getServerUrl } from '../api';
import { getAccount } from '../lib/account';

const KEEP_MS = 180_000;
const CHECKOUT_MS = 30_000; // a full snapshot this often, so a report holds 180–210s
const MAX_LOGS = 50;

type Log = { level: string; msg: string; ts: number };
let segments: eventWithTime[][] = [];
let logs: Log[] = [];
let started = false;

const log = (level: string, msg: string) => {
  logs.push({ level, msg: msg.slice(0, 2000), ts: Date.now() });
  if (logs.length > MAX_LOGS) logs.shift();
};

export function startRecorder(): void {
  if (started) return;
  started = true;

  const origError = console.error;
  console.error = (...args: unknown[]) => {
    log('error', args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' '));
    origError.apply(console, args);
  };
  window.addEventListener('error', (e) => log('error', e.message));
  window.addEventListener('unhandledrejection', (e) => log('error', `Unhandled: ${e.reason}`));

  // Failed requests: method, URL and status only — bodies can carry API keys.
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const req = new Request(...args);
    try {
      const res = await origFetch(...args);
      if (!res.ok) log('fetch', `${req.method} ${req.url} → ${res.status}`);
      return res;
    } catch (e) {
      log('fetch', `${req.method} ${req.url} → ${e}`);
      throw e;
    }
  };

  record({
    checkoutEveryNms: CHECKOUT_MS,
    maskInputOptions: { password: true },
    sampling: { mousemove: 50, scroll: 150, input: 'last' },
    emit(event, isCheckout) {
      if (isCheckout || !segments.length) segments.push([]);
      segments[segments.length - 1].push(event);
      // Drop the oldest segment once the next one already reaches back KEEP_MS.
      while (segments.length > 1 && segments[1][0].timestamp <= event.timestamp - KEEP_MS) segments.shift();
    },
  });
}

export const snapshot = () => ({ events: segments.flat(), logs: [...logs] });

export async function sendReport(description: string, data: ReturnType<typeof snapshot>): Promise<void> {
  const gz = new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'));
  const form = new FormData();
  form.append('description', description);
  form.append('url', location.href);
  form.append('userAgent', navigator.userAgent);
  form.append('data', await new Response(gz).blob(), 'report.json.gz');
  const account = getAccount();
  const res = await fetch(`${getServerUrl()}/bug-reports`, {
    method: 'POST',
    body: form,
    headers: account ? { Authorization: `Bearer ${account.token}` } : {},
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail || `${res.status} ${res.statusText}`);
}
