import { useEffect, useRef } from 'react';
import { renderMarkdown } from '../lib/markdown';
import type { PromptVarMap } from '../lib/promptdata';
import { actions } from '../store';
import type { Bullet } from '../types';

interface Props {
  bullet: Bullet;
  titles: Record<string, string>;
  vars: PromptVarMap;
}

/**
 * A chat bullet's conversation so far, read-only, above its message box in the
 * node popup. Nothing here sends anything: the bullet's text is the next
 * message, and Run node sends it like any other run — the exchange lands here
 * when it finishes. Only the latest reply flows on to the next bullet.
 */
export function ChatHistory({ bullet, titles, vars }: Props) {
  const list = useRef<HTMLDivElement | null>(null);
  const turns = bullet.chat;

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  if (!turns.length) {
    return (
      <p className="chat__hint">
        Write a message below and press <b>Send</b>. Each reply is what flows on to the next bullet; reply
        again to refine it.
      </p>
    );
  }

  const last = turns.map((m) => m.role).lastIndexOf('assistant');
  return (
    <div className="chat">
      <div className="chat__list" ref={list}>
        {turns.map((m, i) => (
          <div key={i} className={`chat__msg chat__msg--${m.role}`}>
            {i === last && (
              <span className="chat__tag" title="This bullet's answer — what the next bullet receives">
                Passed on
              </span>
            )}
            <div
              className="chat__bubble"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content, titles, vars) }}
            />
          </div>
        ))}
      </div>
      <div className="chat__bar">
        <button
          className="chat__clear"
          title="Forget the conversation. The next run starts over from the opening message."
          onClick={() => {
            if (confirm('Clear this chat?')) actions.clearChat(bullet.id);
          }}
        >
          Clear chat
        </button>
      </div>
    </div>
  );
}
