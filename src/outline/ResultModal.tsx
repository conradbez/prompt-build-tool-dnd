import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FileGallery } from '../RunFiles';
import { renderMarkdown } from '../lib/markdown';
import { displayToRaw, toDisplay } from '../lib/mentions';
import { usePromptVarMap, type PromptVarMap } from '../lib/promptdata';
import { actions, firstLine, getState, titleMap, useOutline } from '../store';
import { PYTHON_CAPTION, type Bullet } from '../types';
import { NodeSettings } from '../NodeSettings';
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
 * Above the columns sits the bullet's settings, folded away behind an
 * expander: what a bullet *is* — template, python, agent, held to JSON — is half
 * the answer to "why did it say that", and changing it is the other half.
 * Neither should need the modal closed first. Opened via "Settings…" in the
 * outline, it starts expanded.
 */
export function ResultModal({ bullet, prompt, result }: Props) {
  const close = () => actions.openResult(null);
  const [showSettings, setShowSettings] = useState(
    () => getState().openSettingsId === bullet.id,
  );
  // One column blown up to fill the screen, or none. Escape shrinks it back
  // before it closes the modal.
  const [full, setFull] = useState<ColKey | null>(null);
  const fullProps = (key: ColKey) => ({
    full: full === key,
    onFull: () => setFull((f) => (f === key ? null : key)),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (full) setFull(null);
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const { running } = useOutline();
  const titles = titleMap(getState());
  const vars = usePromptVarMap();
  const status = getState().runStatus[bullet.id];
  const failure = getState().runFailures[bullet.id];
  const files = getState().files[bullet.id];
  const title = toDisplay(firstLine(bullet.text), titles) || (bullet.kind === 'python' ? 'Python' : 'Untitled');

  return (
    <div
      className={`res-modal${full ? ' res-modal--full' : ''}`}
      onClick={close}
      role="dialog"
      aria-modal="true"
    >
      <div className="res-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal__head">
          <h2 className="res-modal__title" title={title}>
            {title}
          </h2>
          <KindChip kind={bullet.kind} mcpServer={bullet.mcpServer} test={getState().tests[bullet.id]} />
          {bullet.jsonOutput && <JsonChip />}
          <button
            className="res-modal__run"
            disabled={running}
            title="Runs this bullet and every bullet it depends on, using promptmap’s select. Everything else keeps its last answer."
            onClick={() => actions.runNode(bullet.id)}
          >
            {running ? 'Running…' : 'Run node'}
          </button>
          <button className="res-modal__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={`res-expander ${showSettings ? 'res-expander--open' : ''}`}>
          <button
            className="res-expander__toggle"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((v) => !v)}
          >
            <span className="res-expander__caret" aria-hidden="true">
              ▸
            </span>
            Settings
          </button>
          {showSettings && <NodeSettings bullet={bullet} />}
        </div>

        <div className={`res-modal__cols${full ? ' res-modal__cols--solo' : ''}`}>
          <section className={`res-col${full === 'text' ? ' res-col--full' : ''}`}>
            <ColHead {...fullProps('text')}>Your prompt</ColHead>
            {bullet.kind === 'python' ? (
              // A python bullet has no text of its own, and typing on one is
              // refused everywhere else — so it is not an editor here either.
              <p className="res-col__empty">{PYTHON_CAPTION}</p>
            ) : (
              <Editor bullet={bullet} titles={titles} />
            )}
          </section>

          <Column
            {...fullProps('input')}
            heading="Model input"
            body={prompt}
            titles={titles}
            vars={vars}
            empty="Not recorded — run this bullet again to capture it."
          />
          {bullet.kind === 'agent' && (status === 'running' || status === 'queued') ? (
            <LiveLog id={bullet.id} waiting={status === 'queued'} {...fullProps('output')} />
          ) : status === 'error' || status === 'skipped' ? (
            <section className={`res-col${full === 'output' ? ' res-col--full' : ''}`}>
              <ColHead {...fullProps('output')}>{status === 'error' ? 'Error' : 'Skipped'}</ColHead>
              <pre className="res-col__error">{failure || 'No message was given.'}</pre>
            </section>
          ) : (
            <Column
              {...fullProps('output')}
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
function LiveLog({ id, waiting, full, onFull }: { id: string; waiting: boolean } & FullProps) {
  const lines = useOutline().runLog.filter((l) => l.kind === 'log' && l.id === id);
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  // Posted by `agent_exec._start_browser` once the sandbox's browser is up.
  const browser = lines.map((l) => l.title.match(/watch live at (\S+)/)?.[1]).find(Boolean);
  return (
    <section className={`res-col${full ? ' res-col--full' : ''}`}>
      <ColHead full={full} onFull={onFull}>
        Agent log
        {browser && (
          <>
            {' · '}
            <a href={browser} target="_blank" rel="noreferrer">
              Open remote browser
            </a>
          </>
        )}
      </ColHead>
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
  full,
  onFull,
}: FullProps & {
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
    <section className={`res-col${full ? ' res-col--full' : ''}`}>
      <ColHead full={full} onFull={onFull}>
        {heading}
      </ColHead>
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

type ColKey = 'text' | 'input' | 'output';

interface FullProps {
  /** This column fills the screen. */
  full: boolean;
  onFull: () => void;
}

/** A column's heading, with the button top right that blows it up to full screen. */
function ColHead({ full, onFull, children }: FullProps & { children: ReactNode }) {
  return (
    <h3 className="res-col__head res-col__head--tools">
      <span className="res-col__title">{children}</span>
      <button
        className="res-col__full"
        onClick={onFull}
        title={full ? 'Back to three columns (Esc)' : 'Full screen'}
        aria-label={full ? 'Exit full screen' : 'Full screen'}
        aria-pressed={full}
      >
        {full ? '⤡' : '⤢'}
      </button>
    </h3>
  );
}
