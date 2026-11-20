import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { eventWithTime } from 'rrweb';
import { recentEvents, sendBugReport } from './lib/bugRecorder';

/**
 * The bug button beside Run. The recording is taken the moment it is pressed,
 * so the report shows what led up to it rather than someone typing the note.
 */
export function BugButton() {
  const [events, setEvents] = useState<eventWithTime[] | null>(null);
  return (
    <>
      <button
        className="tb__gear tb__bug"
        onClick={() => setEvents(recentEvents())}
        title="Report a bug (sends the last 3 minutes of this page)"
        aria-label="Report a bug"
      >
        🐞
      </button>
      {/* Portalled: the toolbar row would otherwise clip it. */}
      {events && createPortal(<BugModal events={events} onClose={() => setEvents(null)} />, document.body)}
    </>
  );
}

function BugModal({ events, onClose }: { events: eventWithTime[]; onClose: () => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const seconds = events.length
    ? Math.round((events[events.length - 1].timestamp - events[0].timestamp) / 1000)
    : 0;

  const submit = async () => {
    if (!text.trim() || status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      await sendBugReport(text.trim(), events);
      setStatus('sent');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('idle');
    }
  };

  return (
    <div className="res-modal" onClick={onClose} role="dialog" aria-modal="true">
      <form
        className="res-modal__panel res-modal__panel--narrow"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="res-modal__head">
          <h2 className="res-modal__title">Report a bug</h2>
          <button type="button" className="res-modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {status === 'sent' ? (
          <div className="key-modal">
            <p className="key-modal__note">Thanks — the report and recording were sent.</p>
            <button type="button" className="tb__run key-modal__run" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        ) : (
          <div className="key-modal">
            <p className="key-modal__note">
              What went wrong? A replay of the last {seconds > 0 ? `${seconds}s` : 'few minutes'} on this
              page goes with it (password fields are hidden).
            </p>
            <textarea
              className="pd-input bug-modal__text"
              data-native-undo
              rows={4}
              maxLength={4000}
              placeholder="e.g. I pressed Run and the result never appeared"
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {error && <p className="bug-modal__error">{error}</p>}
            <button
              className="tb__run key-modal__run"
              type="submit"
              disabled={!text.trim() || status === 'sending' || events.length === 0}
            >
              {status === 'sending' ? 'Sending…' : 'Send report'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
