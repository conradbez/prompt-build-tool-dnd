import { useEffect, useRef } from 'react';
import { renderMarkdown } from '../lib/markdown';
import type { PromptVarMap } from '../lib/promptdata';
import { actions, useOutline } from '../store';
import type { Bullet } from '../types';
import { MentionTextarea } from './mentionAutocomplete';

interface Props {
  bullet: Bullet;
  titles: Record<string, string>;
  vars: PromptVarMap;
  /** The message being written — raw, mentions as id tokens. The popup holds
   *  it, because its header's Send button sends it. */
  draft: string;
  setDraft: (raw: string) => void;
}

/**
 * A chat bullet's whole left column in the node popup: the conversation, then
 * a box for the next message. The popup's Send button (or ⌘/Ctrl+Enter) sends
 * it — see `actions.sendChat`.
 *
 * The first message is the bullet's text — the request, also editable in the
 * outline. Every later one is a follow-up. Each run sends the first message,
 * then the conversation so far; the newest reply is the one passed on.
 */
export function ChatHistory({ bullet, titles, vars, draft, setDraft }: Props) {
  const list = useRef<HTMLDivElement | null>(null);
  const { running } = useOutline();
  const first = bullet.text.trim();
  const turns = bullet.chat;

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, first]);

  const last = turns.map((m) => m.role).lastIndexOf('assistant');
  return (
    <div className="chat chat--full">
      {first || turns.length ? (
        <div className="chat__list" ref={list}>
          {first && <Bubble role="user" content={bullet.text} titles={titles} vars={vars} />}
          {turns.map((m, i) => (
            <Bubble
              key={i}
              role={m.role}
              content={m.content}
              titles={titles}
              vars={vars}
              current={i === last}
            />
          ))}
        </div>
      ) : (
        <p className="chat__hint">
          Write your request below and press <b>Send</b> — or just press Send to run on this bullet&rsquo;s name
          and what the bullets below it said. Its reply is what flows on; send follow-ups to amend it. Type @ to
          bring in another bullet&rsquo;s response.
        </p>
      )}
      <div className="chat__compose" onKeyDownCapture={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!running) {
            actions.sendChat(bullet.id, draft);
            setDraft('');
          }
        }
      }}>
        <MentionTextarea
          className="chat__input"
          value={draft}
          onChange={setDraft}
          titles={titles}
          vars={vars}
          placeholder={
            first ? 'Follow-up to amend the answer… (⌘/Ctrl+Enter sends)' : 'Your request… (⌘/Ctrl+Enter sends)'
          }
        />
        {turns.length > 0 && (
          <div className="chat__bar">
            <button
              className="chat__clear"
              title="Forget the follow-ups and replies. The first message stays; the next run answers it alone."
              onClick={() => {
                if (confirm('Clear the follow-ups?')) actions.clearChat(bullet.id);
              }}
            >
              Clear follow-ups
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({
  role,
  content,
  titles,
  vars,
  current,
}: {
  role: 'user' | 'assistant';
  content: string;
  titles: Record<string, string>;
  vars: PromptVarMap;
  current?: boolean;
}) {
  return (
    <div className={`chat__msg chat__msg--${role}`}>
      {current && (
        <span className="chat__tag" title="This bullet's answer — what the next bullet receives">
          Node response (passed on)
        </span>
      )}
      <div className="chat__bubble" dangerouslySetInnerHTML={{ __html: renderMarkdown(content, titles, vars) }} />
    </div>
  );
}
