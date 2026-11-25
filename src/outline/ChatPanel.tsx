import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { chatInput } from '../api';
import { renderMarkdown } from '../lib/markdown';
import { toDisplay } from '../lib/mentions';
import type { PromptVarMap } from '../lib/promptdata';
import { actions, useOutline } from '../store';
import type { Bullet, ChatMessage } from '../types';

interface Props {
  bullet: Bullet;
  /** What the bullet was last sent by a run, if it has run. */
  prompt: string | undefined;
  /** Its current answer — the latest run's, or the latest chat reply. */
  result: string | undefined;
  titles: Record<string, string>;
  vars: PromptVarMap;
  /** The column heading, with its full-screen button. */
  head: ReactNode;
  className?: string;
}

/**
 * A chat bullet's conversation, in the answer's place in its popup.
 *
 * Each message goes to the model with the bullet's input (as the last run
 * filled it in) and the conversation so far; the reply becomes the bullet's
 * answer, so the bullets it feeds see only that — never the conversation.
 *
 * A run's answer that is not yet in the conversation (a fresh run, or the first
 * one) shows as the latest turn, and is carried in when you reply to it.
 */
export function ChatPanel({ bullet, prompt, result, titles, vars, head, className = '' }: Props) {
  const status = useOutline().runStatus[bullet.id];
  const busyRun = status === 'running' || status === 'queued';
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const list = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);

  const history = bullet.chat;
  const answer = (result ?? '').trim();
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  // The run's answer, when the conversation has not caught up with it.
  const runTurn = !busyRun && answer && answer !== lastAssistant?.content.trim() ? answer : '';
  const shown: (ChatMessage & { run?: boolean })[] = runTurn
    ? [...history, { role: 'assistant', content: runTurn, run: true }]
    : history;

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, pending]);

  // Grow with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const send = async () => {
    const text = draft.trim();
    if (!text || pending || busyRun) return;
    const base: ChatMessage[] = shown.map(({ role, content }) => ({ role, content }));
    const messages: ChatMessage[] = [...base, { role: 'user', content: text }];
    const input = prompt ? chatInput(prompt) : toDisplay(bullet.text, titles);
    setDraft('');
    setError('');
    setPending(true);
    actions.setChat(bullet.id, messages);
    const res = await actions.chat(bullet.id, input, messages);
    setPending(false);
    if (res.reply !== undefined) {
      actions.setChat(bullet.id, [...messages, { role: 'assistant', content: res.reply }], res.reply);
    } else {
      // Nothing came back: put the conversation and the message back as they were.
      actions.setChat(bullet.id, base);
      setDraft(text);
      setError(res.error || 'No reply.');
    }
    box.current?.focus();
  };

  return (
    <section className={`res-col chat ${className}`}>
      {head}
      <div className="chat__list" ref={list}>
        {shown.length === 0 && !pending ? (
          <p className="res-col__empty">
            {busyRun
              ? 'Running now…'
              : 'Ask a question to explore or clarify — or press Run node for a first answer. Only the latest reply flows on to the next bullet.'}
          </p>
        ) : (
          shown.map((m, i) => (
            <div key={i} className={`chat__msg chat__msg--${m.role}`}>
              {m.role === 'assistant' && i === shown.length - 1 && !pending && (
                <span className="chat__tag" title="This is the bullet's answer — what the next bullet receives">
                  {m.run ? 'Current answer · passed on' : 'Passed on'}
                </span>
              )}
              <div
                className="chat__bubble"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content, titles, vars) }}
              />
            </div>
          ))
        )}
        {pending && (
          <div className="chat__msg chat__msg--assistant">
            <div className="chat__bubble chat__bubble--typing" aria-label="Thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>
      {error && <p className="chat__error">{error}</p>}
      <div className="chat__compose">
        <textarea
          ref={box}
          className="chat__input"
          rows={1}
          value={draft}
          placeholder={busyRun ? 'Waiting for the run…' : 'Reply… (Enter to send, Shift+Enter for a new line)'}
          disabled={busyRun}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="chat__send" onClick={send} disabled={!draft.trim() || pending || busyRun}>
          Send
        </button>
        <button
          className="chat__clear"
          disabled={!history.length || pending}
          title="Forget the conversation. The current answer stays until the next run, which starts fresh from the input alone."
          onClick={() => {
            if (confirm('Clear this chat?')) actions.setChat(bullet.id, []);
          }}
        >
          Clear
        </button>
      </div>
    </section>
  );
}
