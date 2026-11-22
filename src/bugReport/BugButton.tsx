import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { sendReport, snapshot, startRecorder } from './recorder';
import './bugReport.css';

/**
 * A small gray bug outline pinned bottom-right (portalled to <body> so no
 * toolbar ancestor can break `position: fixed`). Mounting it starts the
 * recorder; pressing it freezes the recording right away, so the report shows
 * what led up to the bug rather than someone typing the note.
 */
export function BugButton() {
  const [data, setData] = useState<ReturnType<typeof snapshot> | null>(null);
  useEffect(() => {
    try {
      startRecorder();
    } catch (e) {
      console.warn('Bug recorder could not start:', e);
    }
  }, []);
  return (
    <>
      {createPortal(
        <button className="bug__fab" onClick={() => setData(snapshot())} title="Report a bug" aria-label="Report a bug">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3 3 0 1 1 6 0v1" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z" />
            <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
          </svg>
        </button>,
        document.body,
      )}
      {data && createPortal(<BugModal data={data} onClose={() => setData(null)} />, document.body)}
    </>
  );
}

function BugModal({ data, onClose }: { data: ReturnType<typeof snapshot>; onClose: () => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const { events } = data;
  const seconds = events.length ? Math.round((events[events.length - 1].timestamp - events[0].timestamp) / 1000) : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!text.trim() || status !== 'idle') return;
    setStatus('sending');
    try {
      await sendReport(text.trim(), data);
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
        <div className="key-modal">
          {status === 'sent' ? (
            <p className="key-modal__note">Thanks — sent.</p>
          ) : (
            <>
              <p className="key-modal__note">
                What went wrong? A replay of the last {seconds}s goes with it (password fields hidden).
              </p>
              <textarea
                className="pd-input bug__text"
                data-native-undo
                rows={4}
                maxLength={4000}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
              {error && <p className="bug__error">{error}</p>}
            </>
          )}
          {status === 'sent' ? (
            <button type="button" className="tb__run key-modal__run" onClick={onClose}>
              Close
            </button>
          ) : (
            <button className="tb__run key-modal__run" type="submit" disabled={!text.trim() || status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Send report'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
