import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { FileGallery } from '../RunFiles';
import { renderMarkdown } from '../lib/markdown';
import { displayToRaw, toDisplay } from '../lib/mentions';
import { usePromptVarMap, type PromptVarMap } from '../lib/promptdata';
import { actions, firstLine, getState, titleMap, useOutline } from '../store';
import { PYTHON_CAPTION, type Bullet } from '../types';
import { BulletMenu } from './BulletMenu';
import { JsonChip, KindChip } from '../mindmap/BulletNode';

interface Props {
  bullet: Bullet;
  /** What the bullet was actually sent: its own text plus its inputs. */
  prompt: string | undefined;
  /** Undefined until this bullet has run — the modal opens either way. */
  result: string | undefined;
}

/**
 * One bullet's run, in three columns: what you wrote, what the model was
 * actually sent, and what came back. It is also how a bullet is opened at all
 * — clicking a node on the map or a bullet's dot in the outline opens this,
 * run or not, so the two right-hand columns are empty until there is a run.
 *
 * The middle column is the point of the thing. A bullet's prompt is not what
 * you typed — its children's answers are appended below it before it goes out —
 * so when a result is surprising, the question is almost always "what did it
 * actually see?", and until now that was unanswerable from the screen.
 *
 * The first column is the live bullet, not a copy of it: reading the three side
 * by side is exactly when you work out what the prompt should have said, and
 * having to close the modal to act on that is the wrong shape.
 *
 * The head carries the same `•••` menu the outline row does, and the same chips,
 * for the same reason: what a bullet *is* — template, python, agent, held to JSON
 * — is half the answer to "why did it say that", and changing it is the other
 * half. Neither should need the modal closed first.
 */
export function ResultModal({ bullet, prompt, result }: Props) {
  const close = () => actions.openResult(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A settings modal open on top takes the Escape for itself.
      if (e.key === 'Escape' && !getState().openSettingsId) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const titles = titleMap(getState());
  const vars = usePromptVarMap();
  const status = getState().runStatus[bullet.id];
  const failure = getState().runFailures[bullet.id];
  const files = getState().files[bullet.id];
  const title = firstLine(bullet.text) || (bullet.kind === 'python' ? 'Python' : 'Untitled');

  return (
    <div className="res-modal" onClick={close} role="dialog" aria-modal="true">
      <div className="res-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal__head">
          <div className="res-modal__menu">
            <BulletMenu bullet={bullet} />
          </div>
          <h2 className="res-modal__title" title={title}>
            {title}
          </h2>
          <KindChip kind={bullet.kind} mcpServer={bullet.mcpServer} test={getState().tests[bullet.id]} />
          {bullet.jsonOutput && <JsonChip />}
          <button className="res-modal__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="res-modal__cols">
          <section className="res-col">
            <h3 className="res-col__head">Your text</h3>
            {bullet.kind === 'python' ? (
              // A python bullet has no text of its own, and typing on one is
              // refused everywhere else — so it is not an editor here either.
              <p className="res-col__empty">{PYTHON_CAPTION}</p>
            ) : (
              <Editor bullet={bullet} titles={titles} />
            )}
          </section>

          <Column
            heading="Model input"
            body={prompt}
            titles={titles}
            vars={vars}
            empty="Not recorded — run this bullet again to capture it."
          />
          {bullet.kind === 'agent' && (status === 'running' || status === 'queued') ? (
            <LiveLog id={bullet.id} waiting={status === 'queued'} />
          ) : status === 'error' || status === 'skipped' ? (
            <section className="res-col">
              <h3 className="res-col__head">{status === 'error' ? 'Error' : 'Skipped'}</h3>
              <pre className="res-col__error">{failure || 'No message was given.'}</pre>
            </section>
          ) : (
            <Column
              heading="Model response"
              body={status === 'running' || status === 'queued' ? undefined : result}
              titles={titles}
              vars={vars}
              empty={
                status === 'running'
                  ? 'Running now…'
                  : status === 'queued'
                    ? 'Waiting for the bullets it depends on…'
                    : 'Not run yet — press Run to fill this in.'
              }
              extra={
                files?.length && status !== 'running' && status !== 'queued' ? (
                  <FileGallery files={files} />
                ) : undefined
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A running agent's log as it arrives, in the answer's place until there is
 * one. Follows the tail, the way the run log does.
 */
function LiveLog({ id, waiting }: { id: string; waiting: boolean }) {
  const lines = useOutline().runLog.filter((l) => l.kind === 'log' && l.id === id);
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <section className="res-col">
      <h3 className="res-col__head">Agent log — live</h3>
      {lines.length ? (
        <pre className="res-col__log" ref={ref}>
          {lines.map((l) => l.title).join('\n')}
        </pre>
      ) : (
        <p className="res-col__empty">
          {waiting ? 'Waiting for the bullets it depends on…' : 'Starting the sandbox…'}
        </p>
      )}
    </section>
  );
}

/**
 * The bullet's own text, editable in place. Writes straight to the store, so
 * the outline and the map update behind the modal as you type — and the change
 * is saved the moment it is made, with nothing to confirm or discard.
 *
 * Mentions are shown in the same short-label form the outline uses, and
 * converted back to id tokens on the way in.
 */
function Editor({ bullet, titles }: { bullet: Bullet; titles: Record<string, string> }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const display = toDisplay(bullet.text, titles);

  // Grow to fit, so the whole prompt is visible without a nested scrollbar
  // until it is genuinely taller than the column.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [display]);

  return (
    <textarea
      ref={ref}
      className="res-col__edit"
      value={display}
      spellCheck={false}
      placeholder="Empty"
      onChange={(e) => actions.setText(bullet.id, displayToRaw(e.target.value, bullet.text, titles))}
    />
  );
}

function Column({
  heading,
  body,
  titles,
  vars,
  empty = 'Empty',
  extra,
}: {
  heading: string;
  body: string | undefined;
  titles: Record<string, string>;
  vars: PromptVarMap;
  empty?: string;
  /** Shown under the text, in the same scroll — a response's files. */
  extra?: ReactNode;
}) {
  const text = (body ?? '').trim();
  return (
    <section className="res-col">
      <h3 className="res-col__head">{heading}</h3>
      {text || extra ? (
        <div className="res-col__body">
          {text && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text, titles, vars) }} />}
          {extra}
        </div>
      ) : (
        <p className="res-col__empty">{empty}</p>
      )}
    </section>
  );
}
