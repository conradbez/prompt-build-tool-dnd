import { useLayoutEffect, useRef, useState } from 'react';
import type { Bullet } from '../types';
import { actions, getState, titleMap } from '../store';
import { register, getEditor } from './focusRegistry';
import { BulletMenu } from './BulletMenu';
import {
  detectMention,
  applyMention,
  toDisplay,
  displayToRaw,
  toSegments,
  mentionIds,
  type TitleMap,
} from '../lib/mentions';
import { renderMarkdown } from '../lib/markdown';
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
}

const MAX_MATCHES = 8;

/**
 * A single outline bullet: one markdown text field. While the caret is in it
 * you edit the raw markdown; the moment it loses focus the text is rendered,
 * so the outline reads as formatted prose.
 */
export function BulletRow({ bullet, depth, selected }: Props) {
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

  return (
    <div
      className={`ol-row ${bullet.template ? 'ol-row--template' : ''}`}
      style={{ marginLeft: depth * 22 }}
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
        <button
          className={`ol-dot ${selected ? 'ol-dot--selected' : hasChildren && bullet.collapsed ? 'ol-dot--full' : ''}`}
          onClick={() => actions.setFocus({ id, caret: 'end' })}
          tabIndex={-1}
          aria-label="Focus bullet"
        />
      </div>

      <div className="ol-fields">
        <div className={`ol-field-wrap ${hasMention ? 'ol-has-mention' : ''}`}>
          {bullet.template && (
            <span className="tpl-chip tpl-chip--outline" title="Not sent to the LLM — its text is its output">
              TPL
            </span>
          )}

          {editing ? (
            <>
              <Mirror raw={bullet.text} titles={titles} />
              <AutoTextarea
                id={id}
                value={display}
                onChange={onChange}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onFocus={() => actions.select(id)}
              />
              {ac && <Dropdown ac={ac} onPick={accept} />}
            </>
          ) : (
            <Rendered bullet={bullet} titles={titles} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The read view: the bullet's markdown, rendered. Clicking starts editing. */
function Rendered({ bullet, titles }: { bullet: Bullet; titles: TitleMap }) {
  const html = renderMarkdown(bullet.text, titles);
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
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
}

/** Textarea that grows to fit its content and registers itself for focus. */
function AutoTextarea({ id, value, ...handlers }: AutoProps) {
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
      placeholder="Empty"
      {...handlers}
    />
  );
}
