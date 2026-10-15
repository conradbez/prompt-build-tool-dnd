import { useState } from 'react';

import { Info } from './Info';
import { requestCode, signOut, useAccount, verifyCode } from './lib/account';
import { syncFromServer } from './lib/saves';

/**
 * Sign in with a code emailed to you, so your maps are kept on the server.
 * Optional: signed out, saves stay in this browser as before.
 */
export function AccountSection() {
  const account = useAccount();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
    } catch (e) {
      setStatus({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const send = () =>
    run(async () => {
      await requestCode(email);
      setSent(true);
      setStatus({ text: `Code sent to ${email.trim()}. It works for 10 minutes.` });
    });

  const verify = () =>
    run(async () => {
      await verifyCode(email, code);
      setSent(false);
      setCode('');
      await syncFromServer();
      setStatus({ text: 'Signed in. Your maps are saved on the server as you edit.' });
    });

  return (
    <section className="res-col">
      <h3 className="res-col__head">
        Account
        <Info>
          Optional. Sign in with a code sent to your email and your maps are kept on the server:
          every page load opens the one you edited last. Signed out, saves stay in this browser.
        </Info>
      </h3>
      <div className="res-col__body pd-docs">
        {account ? (
          <div className="pd-row">
            <span>
              Signed in as <strong>{account.email}</strong>
            </span>
            <button className="pd-btn" onClick={() => run(signOut)} disabled={busy}>
              Sign out
            </button>
          </div>
        ) : (
          <form
            className="pd-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void (sent ? verify() : send());
            }}
          >
            <input
              className="pd-input"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              disabled={sent}
              onChange={(e) => setEmail(e.target.value)}
            />
            {sent && (
              <input
                className="pd-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                value={code}
                autoFocus
                onChange={(e) => setCode(e.target.value)}
              />
            )}
            <button className="pd-btn" type="submit" disabled={busy || !email.trim() || (sent && code.length < 6)}>
              {sent ? 'Sign in' : 'Email me a code'}
            </button>
            {sent && (
              <button
                className="pd-btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setSent(false);
                  setCode('');
                  setStatus(null);
                }}
              >
                Back
              </button>
            )}
          </form>
        )}
        {status && <p className={`pd-status ${status.bad ? 'pd-status--bad' : ''}`}>{status.text}</p>}
      </div>
    </section>
  );
}
