import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FileGallery } from '../RunFiles';
import { renderMarkdown } from '../lib/markdown';
import { displayToRaw, toDisplay } from '../lib/mentions';
import { usePromptVarMap, type PromptVarMap } from '../lib/promptdata';
import { actions, getState, titleMap, useOutline } from '../store';
import { PYTHON_CAPTION, type Bullet } from '../types';
import { NodeSettings } from '../NodeSettings';
import { JsonChip, KindChip } from '../mindmap/BulletNode';
import { AgentLinks, agentLinks } from '../AgentLinks';
import { Attachments } from './BulletRow';
import { useFileDrop } from './fileDrop';

interface Props {
  bullet: Bullet;
  /** What the bullet was actually sent: its own text plus its inputs. */
  prompt: string | undefined;
  /** Undefined until this bullet has run — the modal opens either way. */
  result: string | undefined;
}

/**
 * One bullet's run, in two columns split by a bar you can drag: what you wrote
 * on the left, what came back on the right. It is also how a bullet is opened
 * at all — clicking a node on the map or a bullet's dot in the outline opens
 * this, run or not, so the right-hand column is empty until there is a run.
 *
 * Under your prompt, folded away, is what the model was actually sent. A
 * bullet's prompt is not what you typed — its children's answers are appended
 * below it before it goes out — so when a result is surprising, the question is
 * almost always "what did it actually see?".
 *
 * The left column is the live bullet, not a copy of it: reading it beside the
 * answer is exactly when you work out what the prompt should have said, and
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

  const drop = useFileDrop(bullet.id);
  const [split, startDrag, resetSplit] = useSplit();
  const cols = useRef<HTMLDivElement | null>(null);
  const [showInput, setShowInput] = useState(false);

  const { running, runLog } = useOutline();
  // An agent's log lines, for the links it posted — see `AgentLinks`.
  const logLines = runLog.filter((l) => l.kind === 'log' && l.id === bullet.id).map((l) => l.title);
  const titles = titleMap(getState());
  const vars = usePromptVarMap();
  const status = getState().runStatus[bullet.id];
  const failure = getState().runFailures[bullet.id];
  const files = getState().files[bullet.id];
  const title = titles[bullet.id] || 'Untitled';
  // Under the answer column's heading, where the live browser and the app an
  // agent served are looked for — see `AgentLinks`.
  const links =
    bullet.kind === 'agent' ? <AgentLinks className="rp__pins--col" links={agentLinks(logLines, result)} /> : undefined;

  return (
    <div
      className={`res-modal${full ? ' res-modal--full' : ''}`}
      onClick={close}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`res-modal__panel${drop.over ? ' res-modal__panel--filedrop' : ''}`}
        onClick={(e) => e.stopPropagation()}
        {...drop.handlers}
      >
        <div className="res-modal__head">
          {/* The bullet's name, edited in place — the same title as the outline's top line. */}
          <input
            className="res-modal__title"
            value={bullet.title}
            placeholder={title}
            aria-label="Title"
            spellCheck={false}
            onChange={(e) => actions.setTitle(bullet.id, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
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

        <div
          ref={cols}
          className={`res-modal__cols res-split${full ? ' res-modal__cols--solo' : ''}`}
          style={{ '--split': `${split}%` } as React.CSSProperties}
        >
          <section className={`res-col res-left${full === 'text' || full === 'input' ? ' res-col--full' : ''}`}>
            {full !== 'input' && (
              <>
                <ColHead {...fullProps('text')}>Your prompt</ColHead>
                {bullet.kind === 'python' ? (
                  // A python bullet has no text of its own, and typing on one is
                  // refused everywhere else — so it is not an editor here either.
                  <p className="res-col__empty">{PYTHON_CAPTION}</p>
                ) : (
                  <Editor bullet={bullet} titles={titles} />
                )}
                <Attachments bullet={bullet} />
              </>
            )}
            {full !== 'text' && (
              <ModelInput
                open={showInput || full === 'input'}
                onToggle={() => setShowInput((v) => !v)}
                body={prompt}
                titles={titles}
                vars={vars}
                {...fullProps('input')}
              />
            )}
          </section>

          <div
            className="res-split__bar"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(split)}
            title="Drag to resize · double-click for half and half"
            onPointerDown={(e) => cols.current && startDrag(e, cols.current)}
            onDoubleClick={resetSplit}
          />

          {bullet.kind === 'agent' && (status === 'running' || status === 'queued') ? (
            <LiveLog id={bullet.id} waiting={status === 'queued'} links={links} {...fullProps('output')} />
          ) : status === 'error' || status === 'skipped' ? (
            <section className={`res-col${full === 'output' ? ' res-col--full' : ''}`}>
              <ColHead {...fullProps('output')}>{status === 'error' ? 'Error' : 'Skipped'}</ColHead>
              {links}
              <pre className="res-col__error">{failure || 'No message was given.'}</pre>
            </section>
          ) : (
            <Column
              {...fullProps('output')}
              heading="Model response"
              top={links}
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
function LiveLog({
  id,
  waiting,
  links,
  full,
  onFull,
}: { id: string; waiting: boolean; links?: ReactNode } & FullProps) {
  const lines = useOutline().runLog.filter((l) => l.kind === 'log' && l.id === id);
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <section className={`res-col${full ? ' res-col--full' : ''}`}>
      <ColHead full={full} onFull={onFull}>
        Agent log
      </ColHead>
      {links}
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
  top,
  extra,
  full,
  onFull,
}: FullProps & {
  heading: string;
  /** Under the heading, above the text — an agent's links. */
  top?: ReactNode;
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
      {top}
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

/**
 * What the model was actually sent, folded under your prompt. Opened, it takes
 * the lower part of the column and scrolls on its own.
 */
function ModelInput({
  open,
  onToggle,
  body,
  titles,
  vars,
  full,
  onFull,
}: FullProps & {
  open: boolean;
  onToggle: () => void;
  body: string | undefined;
  titles: Record<string, string>;
  vars: PromptVarMap;
}) {
  const text = (body ?? '').trim();
  return (
    <div className={`res-input${open ? ' res-input--open' : ''}${full ? ' res-input--full' : ''}`}>
      <h3 className="res-col__head res-col__head--tools res-input__head">
        <button className="res-input__toggle" aria-expanded={open} onClick={onToggle} disabled={full}>
          <span className="res-expander__caret" aria-hidden="true">
            ▸
          </span>
          Model input
        </button>
        {open && (
          <button
            className="res-col__full"
            onClick={onFull}
            title={full ? 'Back (Esc)' : 'Full screen'}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            aria-pressed={full}
          >
            {full ? '⤡' : '⤢'}
          </button>
        )}
      </h3>
      {open &&
        (text ? (
          <div
            className="res-col__body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text, titles, vars) }}
          />
        ) : (
          <p className="res-col__empty">Not recorded — run this bullet again to capture it.</p>
        ))}
    </div>
  );
}

/** Where the bar between the columns sits, as a percentage — the same for every bullet. */
const SPLIT_KEY = 'wm.modal.split';
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= SPLIT_MIN && v <= SPLIT_MAX ? v : 50;
  } catch {
    return 50;
  }
}

function writeSplit(v: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(v * 10) / 10));
  } catch {
    /* kept for this page load */
  }
}

/**
 * The split between the columns: its percentage, a pointer-down handler that
 * drags it, and a reset to half and half. Saved when a drag ends, so the next
 * bullet opened — or this one, opened again — starts where it was left.
 */
function useSplit(): [number, (e: React.PointerEvent, box: HTMLElement) => void, () => void] {
  const [split, setSplit] = useState(readSplit);
  const start = (e: React.PointerEvent, box: HTMLElement) => {
    e.preventDefault();
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const rect = box.getBoundingClientRect();
    let last = split;
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      last = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
      setSplit(last);
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      document.body.classList.remove('res-split--dragging');
      writeSplit(last);
    };
    document.body.classList.add('res-split--dragging');
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  };
  const reset = () => {
    setSplit(50);
    writeSplit(50);
  };
  return [split, start, reset];
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
        title={full ? 'Back to both columns (Esc)' : 'Full screen'}
        aria-label={full ? 'Exit full screen' : 'Full screen'}
        aria-pressed={full}
      >
        {full ? '⤡' : '⤢'}
      </button>
    </h3>
  );
}
