import { useLayoutEffect, useRef, useState } from 'react';
import { PYTHON_CAPTION, type Bullet } from '../types';
import { actions, getState, titleMap } from '../store';
import { register, getEditor } from './focusRegistry';
import { BulletMenu } from './BulletMenu';
import { KindChip } from '../mindmap/BulletNode';
import {
  detectMention,
  applyMention,
  toDisplay,
  displayToRaw,
  toSegments,
  mentionIds,
  type TitleMap,
} from '../lib/mentions';
import { renderInlineMarkdown, renderMarkdown } from '../lib/markdown';
import { deleteFile, fileLink } from '../api';
import { INDENT } from './dragDrop';
import { caretAtStart, caretOnFirstLine, caretOnLastLine } from '../lib/caret';

interface Match {
  id: string;
  /** Shown in the dropdown. */
  title: string;
}

interface AutocompleteState {
  start: number;
  index: number;
  matches: Match[];
}

/** Full text of a hovered mention, pinned to the pointer. */
interface Tip {
  x: number;
  y: number;
  text: string;
}

interface Props {
  bullet: Bullet;
  depth: number;
  /** True when this bullet is the one highlighted in the mind map. */
  selected: boolean;
  /** True while this row (or an ancestor of it) is being dragged. */
  dragging: boolean;
  /** Press on the bullet dot — the drag handle. */
  onDragStart: (id: string, e: React.PointerEvent) => void;
  /** This bullet's latest run output, if it has one. */
  result?: string;
  /** Open the full answer in a modal — the one-line preview is only a handle. */
  onExpand: (id: string) => void;
}

const MAX_MATCHES = 8;

/**
 * A single outline bullet: one markdown text field. While the caret is in it
 * you edit the raw markdown; the moment it loses focus the text is rendered,
 * so the outline reads as formatted prose.
 */
export function BulletRow({ bullet, depth, selected, dragging, onDragStart, result, onExpand }: Props) {
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const { id } = bullet;

  const titles: TitleMap = titleMap(getState());
  // The stored text holds `@[[id]]` tokens; the editor works on the display
  // form, where each token is the target's first line, first 10 characters.
  const display = toDisplay(bullet.text, titles);
  const editing = getState().focus?.id === id;

  function findMatches(query: string): Match[] {
    const s = getState();
    return Object.values(s.bullets)
      .filter((b) => b.id !== id && (titles[b.id] || '').toLowerCase().includes(query))
      .slice(0, MAX_MATCHES)
      .map((b) => ({ id: b.id, title: titles[b.id] || 'Untitled' }));
  }

  function refreshMention(el: HTMLTextAreaElement) {
    const m = detectMention(el.value, el.selectionStart);
    if (!m) {
      setAc(null);
      return;
    }
    const matches = findMatches(m.query);
    if (matches.length === 0) {
      setAc(null);
      return;
    }
    setAc({ start: m.start, index: 0, matches });
  }

  function accept(match: Match) {
    const el = getEditor(id);
    if (!el || !ac) return;
    // The id — not the text — is what gets stored, so editing the target
    // later just changes how this mention reads.
    const { raw, caret } = applyMention(
      el.value,
      bullet.text,
      ac.start,
      el.selectionStart,
      { id: match.id, title: titles[match.id] ?? '' },
      titles,
    );
    actions.setText(id, raw);
    setAc(null);
    requestAnimationFrame(() => {
      const el2 = getEditor(id);
      if (el2) {
        el2.focus();
        el2.setSelectionRange(caret, caret);
      }
    });
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    // Back to the stored form (labels → id tokens) before anything is saved.
    actions.setText(id, displayToRaw(e.currentTarget.value, bullet.text, titles));
    refreshMention(e.currentTarget);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;

    // ---- Autocomplete has priority while it is open ----
    if (ac && ac.matches.length > 0) {
      const n = ac.matches.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAc({ ...ac, index: (ac.index + 1) % n });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAc({ ...ac, index: (ac.index - 1 + n) % n });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(ac.matches[ac.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAc(null);
        return;
      }
    }

    // ---- Enter makes the next bullet; Shift+Enter is a newline ----
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      actions.addSiblingAfter(id);
      return;
    }

    // ---- Tab / Shift+Tab: indent / outdent ----
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) actions.outdent(id);
      else actions.indent(id);
      return;
    }

    // ---- Alt+Shift+Up/Down: reorder the bullet (Workflowy) ----
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.key === 'ArrowUp') actions.moveUp(id);
      else actions.moveDown(id);
      return;
    }

    // ---- Vertical navigation across bullets ----
    if (e.key === 'ArrowUp' && caretOnFirstLine(el)) {
      e.preventDefault();
      actions.moveFocus({ id }, -1);
      return;
    }
    if (e.key === 'ArrowDown' && caretOnLastLine(el)) {
      e.preventDefault();
      actions.moveFocus({ id }, 1);
      return;
    }

    // ---- Backspace at the very start deletes an empty bullet ----
    if (e.key === 'Backspace' && caretAtStart(el)) {
      if (bullet.text === '' && bullet.children.length === 0) {
        e.preventDefault();
        actions.deleteBullet(id);
      }
    }
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      refreshMention(e.currentTarget);
    }
  }

  /**
   * Which mention is under the pointer. While editing, the textarea covers the
   * coloured mirror, so a plain `title` attribute never fires — but the spans
   * opt back into pointer-events, which puts them in `elementsFromPoint`'s list
   * underneath it. The rendered view is hit the same way.
   */
  function onMouseMove(e: React.MouseEvent) {
    const hit = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => el.classList.contains('ol-mention') || el.classList.contains('md-mention')) as
      | HTMLElement
      | undefined;
    const full = hit?.dataset.title;
    if (!full) {
      if (tip) setTip(null);
      return;
    }
    if (tip?.text !== full || tip.x !== e.clientX) setTip({ x: e.clientX, y: e.clientY, text: full });
  }

  const hasChildren = bullet.children.length > 0;
  const hasMention = mentionIds(bullet.text).length > 0;
  // A python bullet takes no typing — it runs what its children wrote. The
  // editor still mounts (focus and arrow-key navigation run through it), it
  // just refuses input and reads out what the bullet does instead.
  const isPython = bullet.kind === 'python';

  return (
    <div
      className={`ol-row ${bullet.kind !== 'prompt' ? `ol-row--${bullet.kind}` : ''} ${dragging ? 'ol-row--dragging' : ''}`}
      data-row={id}
      style={{ marginLeft: depth * INDENT }}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setTip(null)}
    >
      {tip && <MentionTip tip={tip} />}
      <div className="ol-gutter">
        <BulletMenu bullet={bullet} />
        <button
          className={`ol-caret ${hasChildren ? '' : 'ol-caret--hidden'}`}
          onClick={() => actions.toggleCollapse(id)}
          tabIndex={-1}
          aria-label={bullet.collapsed ? 'Expand' : 'Collapse'}
        >
          {bullet.collapsed ? '▸' : '▾'}
        </button>
        {/* The dot doubles as the drag handle, as in Workflowy: press and move
            to drag the bullet (and its subtree), click to open it — the same
            modal its answer opens. The text stays editable in the row, so
            opening a bullet is a deliberate click on the dot, not a side
            effect of clicking where you meant to type. */}
        <button
          className={`ol-dot ${selected ? 'ol-dot--selected' : hasChildren && bullet.collapsed ? 'ol-dot--full' : ''}`}
          onPointerDown={(e) => {
            if (e.button === 0 || e.pointerType !== 'mouse') onDragStart(id, e);
          }}
          onClick={() => {
            actions.select(id);
            onExpand(id);
          }}
          tabIndex={-1}
          aria-label="Open bullet, or drag to move it"
        />
      </div>

      <div className="ol-fields">
        <div className={`ol-field-wrap ${hasMention ? 'ol-has-mention' : ''}`}>
          <KindChip kind={bullet.kind} className="tpl-chip--outline" />

          {/* Read view and editor are stacked in one grid cell and *both*
              stay mounted, one of them merely hidden. Swapping one for the
              other made the row's height jump the moment you clicked into it
              — raw markdown and its rendered form are never quite the same
              box — and every row below it moved. Stacked, the cell is as tall
              as the taller of the two whatever has focus, so the outline
              holds still. */}
          <div className={`ol-view ${editing ? 'ol-view--editing' : ''}`}>
            <Rendered bullet={bullet} titles={titles} />
            {editing && <Mirror raw={bullet.text} titles={titles} />}
            <AutoTextarea
              id={id}
              value={isPython ? '' : display}
              readOnly={isPython}
              placeholder={isPython ? PYTHON_CAPTION : 'Empty'}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onFocus={() => actions.select(id)}
            />
            {editing && ac && <Dropdown ac={ac} onPick={accept} />}
          </div>

          {bullet.files.length > 0 && (
            <ul className="ol-files">
              {bullet.files.map((f) => (
                <li className="ol-file" key={f.key}>
                  <button
                    className="ol-file__name"
                    title={`Download ${f.name}`}
                    // The row hands clicks to the editor; this one is ours.
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={async () => {
                      try {
                        // Signed on demand and short-lived, so the link can't
                        // be kept or shared for long.
                        window.location.href = await fileLink(f);
                      } catch (err) {
                        actions.setRunResult({}, [
                          err instanceof Error ? err.message : String(err),
                        ]);
                      }
                    }}
                  >
                    📎 {f.name}
                  </button>
                  <button
                    className="ol-file__x"
                    title="Remove this attachment"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => {
                      actions.detachFile(id, f.key);
                      void deleteFile(f.key);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* The result column. Every row reserves it, whether or not there is an
          answer yet, so the bullets keep a straight right edge and the column
          does not appear and disappear as runs come in. */}
      <div className="ol-result">
        {result !== undefined && (
          <>
            {/* The answer *is* the control — clicking it opens the full text.
                It hugs its content rather than filling the column, so the tint
                that comes up on hover reads as a box around this one answer. */}
            <button
              type="button"
              className="ol-result__text"
              title={result}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onExpand(id)}
              // Inline marks only — the answer's own emphasis survives, its
              // block structure does not, because none of it fits on one line.
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(result, titles) }}
            />
            <button
              className="ol-result__more"
              title="Open the full answer"
              aria-label="Open the full answer"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onExpand(id)}
            >
              ⤢
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The read view: the bullet's markdown, rendered. Clicking starts editing. */
function Rendered({ bullet, titles }: { bullet: Bullet; titles: TitleMap }) {
  const html =
    bullet.kind === 'python'
      ? `<p class="ol-md__empty">${PYTHON_CAPTION}</p>`
      : renderMarkdown(bullet.text, titles);
  return (
    <div
      className="ol-md"
      onMouseDown={(e) => {
        // Focus is driven by the store, so take the click ourselves.
        e.preventDefault();
        actions.setFocus({ id: bullet.id, caret: 'end' });
      }}
      dangerouslySetInnerHTML={{ __html: html || '<p class="ol-md__empty">Empty</p>' }}
    />
  );
}

/**
 * The coloured copy of the text sitting behind the textarea. A textarea can't
 * style part of its own value, so when the text holds a mention the textarea's
 * glyphs go transparent (caret and selection stay) and this mirror — same font,
 * same box, same string — is what you actually read.
 */
function Mirror({ raw, titles }: { raw: string; titles: TitleMap }) {
  const segs = toSegments(raw, titles);
  if (!segs.some((sg) => sg.id)) return null;
  return (
    <div className="ol-text ol-mirror" aria-hidden="true">
      {segs.map((sg, i) =>
        sg.id ? (
          <span key={i} className="ol-mention" data-title={titles[sg.id] || 'Untitled'}>
            {sg.text}
          </span>
        ) : (
          <span key={i}>{sg.text}</span>
        ),
      )}
    </div>
  );
}

/** The hovered mention's full first line, following the pointer. */
function MentionTip({ tip }: { tip: Tip }) {
  const x = Math.min(Math.max(tip.x, 90), window.innerWidth - 90);
  return (
    <div className="ol-tip" style={{ left: x, top: tip.y - 10 }} role="tooltip">
      {tip.text}
    </div>
  );
}

function Dropdown({ ac, onPick }: { ac: AutocompleteState; onPick: (m: Match) => void }) {
  return (
    <ul className="ol-ac">
      {ac.matches.map((m, i) => (
        <li
          key={m.id}
          className={`ol-ac__item ${i === ac.index ? 'ol-ac__item--active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(m);
          }}
        >
          @{m.title}
        </li>
      ))}
    </ul>
  );
}

interface AutoProps {
  id: string;
  value: string;
  /** Shown when the value is empty — a python bullet says what it does here. */
  placeholder?: string;
  /** Python bullets take no typing; the editor mounts only to carry focus. */
  readOnly?: boolean;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
}

/** Textarea that grows to fit its content and registers itself for focus. */
function AutoTextarea({ id, value, placeholder = 'Empty', ...handlers }: AutoProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        register(id, el);
      }}
      value={value}
      rows={1}
      spellCheck={false}
      className="ol-text"
      placeholder={placeholder}
      {...handlers}
    />
  );
}
