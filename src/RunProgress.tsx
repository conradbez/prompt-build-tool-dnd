import { useEffect, useRef } from 'react';
import { actions, getState, useOutline } from './store';
import type { RunLogLine } from './types';

/** How each log line is tagged — the same words pbt's own CLI log uses. */
const TAG: Record<RunLogLine['kind'], string> = {
  plan: 'PLAN',
  start: 'RUN',
  log: '',
  success: 'OK',
  error: 'ERROR',
  skipped: 'SKIP',
  end: 'DONE',
};

function clock(ms: number): string {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * The run as it happens: a progress bar, what is running now, and a log in the
 * shape of pbt's CLI output — one line as each bullet starts and finishes, with
 * a failure's full message under it rather than squeezed into the toolbar.
 *
 * Opened from the ☰ beside Run, during a run or after it: the log of the last
 * run stays until the next one starts, which is when a failure gets read.
 */
export function RunProgress() {
  const state = useOutline();
  const close = () => actions.openProgress(false);
  const logRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Follow the tail while the run is live, the way a terminal does — unless
  // the reader has scrolled up to look at something.
  const lines = state.runLog.length;
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom || !state.running) el.scrollTop = el.scrollHeight;
  }, [lines, state.running]);

  const statuses = Object.values(state.runStatus);
  const total = statuses.length;
  const count = (s: string) => statuses.filter((x) => x === s).length;
  const done = count('success') + count('error') + count('skipped');
  const pct = total ? Math.round((done / total) * 100) : 0;
  const now = Object.entries(state.runStatus)
    .filter(([, s]) => s === 'running')
    .map(([id]) => id);

  const logs: Record<string, string[]> = {};
  for (const l of state.runLog) {
    if (l.kind === 'log' && l.id) (logs[l.id] ??= []).push(l.title);
  }

  const open = (id: string | undefined) => {
    if (!id || !getState().bullets[id]) return;
    close();
    actions.openResult(id);
  };

  return (
    <div className="res-modal" onClick={close} role="dialog" aria-modal="true">
      <div className="res-modal__panel res-modal__panel--narrow rp" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal__head">
          <h2 className="res-modal__title">{state.running ? 'Running…' : 'Last run'}</h2>
          <button className="res-modal__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="rp__summary">
          <div className="rp__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`rp__fill${count('error') ? ' rp__fill--failed' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="rp__counts">
            <span>
              {done} of {total} done
            </span>
            {count('success') > 0 && <span className="rp__count rp__count--success">{count('success')} ok</span>}
            {count('running') > 0 && <span className="rp__count rp__count--running">{count('running')} running</span>}
            {count('queued') > 0 && <span className="rp__count">{count('queued')} waiting</span>}
            {count('error') > 0 && <span className="rp__count rp__count--error">{count('error')} failed</span>}
            {count('skipped') > 0 && <span className="rp__count">{count('skipped')} skipped</span>}
          </div>
          {now.length > 0 && (
            <div className="rp__now">
              Now:{' '}
              {now.map((id, i) => (
                <button key={id} className="rp__link" onClick={() => open(id)}>
                  {i > 0 && ', '}
                  {state.runLog.find((l) => l.id === id)?.title ?? 'a bullet'}
                </button>
              ))}
            </div>
          )}
        </div>

        <ol className="rp__log" ref={logRef}>
          {state.runLog.map((line, i) =>
            // An agent's log lines are not shown where they arrived: they are
            // gathered under the line that started it, collapsed (see AgentLog).
            line.kind === 'log' ? null : (
              <li key={i} className={`rp__line rp__line--${line.kind}`}>
                <span className="rp__time">{clock(line.at)}</span>
                <span className="rp__tag">{TAG[line.kind]}</span>
                {line.id ? (
                  <button className="rp__title rp__link" onClick={() => open(line.id)} title="Open this bullet">
                    {line.title}
                  </button>
                ) : (
                  <span className="rp__title">{line.title}</span>
                )}
                {line.detail && line.kind !== 'error' && line.kind !== 'skipped' && (
                  <span className="rp__detail">{line.detail}</span>
                )}
                {line.detail && (line.kind === 'error' || line.kind === 'skipped') && (
                  <pre className="rp__error">{line.detail}</pre>
                )}
                {line.kind === 'start' && line.id && logs[line.id] && (
                  <AgentLog lines={logs[line.id]} live={state.runStatus[line.id] === 'running'} />
                )}
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
  );
}

/**
 * One agent's log, folded into a single line under the bullet that ran it: how
 * many lines, and the latest as a preview, so a busy agent does not bury the
 * rest of the run. Opened, it shows the whole log and follows its tail while
 * the agent is still running. A native <details>, so it stays open or closed
 * across the re-renders every new line causes.
 */
function AgentLog({ lines, live }: { lines: string[]; live: boolean }) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [lines.length, live]);
  const last = lines[lines.length - 1].replace(/^\[\s*[\d.]+s\]\s*/, '');
  return (
    <details className="rp__agentlog">
      <summary className="rp__agentsum">
        <span className="rp__agentcount">
          Agent log · {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
        <span className="rp__agentlast">{last}</span>
      </summary>
      <pre className="rp__agent" ref={ref}>
        {lines.join('\n')}
      </pre>
    </details>
  );
}
