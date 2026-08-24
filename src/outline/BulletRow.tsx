import { useLayoutEffect, useRef, useState } from 'react';
import type { Bullet, Field } from '../types';
import { actions, getState } from '../store';
import { register, getEditor } from './focusRegistry';
import { detectMention, applyMention } from '../lib/mentions';
import {
  caretAtStart,
  caretOnFirstLine,
  caretOnLastLine,
} from '../lib/caret';

interface Match {
  id: string;
  title: string;
}

interface AutocompleteState {
  field: Field;
  start: number;
  index: number;
  matches: Match[];
}

interface Props {
  bullet: Bullet;
  depth: number;
  /** True when this bullet is the one highlighted in the mind map. */
  selected: boolean;
}

const MAX_MATCHES = 8;

/** A single outline bullet: a bold title line and a body underneath. */
export function BulletRow({ bullet, depth, selected }: Props) {
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const { id } = bullet;

  function findMatches(query: string): Match[] {
    const s = getState();
    return Object.values(s.bullets)
      .filter((b) => b.id !== id && b.title.toLowerCase().includes(query))
      .slice(0, MAX_MATCHES)
      .map((b) => ({ id: b.id, title: b.title || 'Untitled' }));
  }

  function refreshMention(el: HTMLTextAreaElement, field: Field) {
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
    setAc({ field, start: m.start, index: 0, matches });
  }

  function accept(field: Field, match: Match) {
    const el = getEditor(id, field);
    if (!el || !ac) return;
    const { text, caret } = applyMention(el.value, ac.start, el.selectionStart, match.title);
    actions.setText(id, field, text);
    actions.addRef(id, match.id);
    setAc(null);
    requestAnimationFrame(() => {
      const el2 = getEditor(id, field);
      if (el2) {
        el2.focus();
        el2.setSelectionRange(caret, caret);
      }
    });
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>, field: Field) {
    actions.setText(id, field, e.currentTarget.value);
    refreshMention(e.currentTarget, field);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, field: Field) {
    const el = e.currentTarget;

    // ---- Autocomplete has priority while open on this field ----
    if (ac && ac.field === field && ac.matches.length > 0) {
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
        accept(field, ac.matches[ac.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAc(null);
        return;
      }
    }

    // ---- Enter: title -> body, body -> new bullet below ----
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (field === 'title') actions.setFocus({ id, field: 'body', caret: 'end' });
      else actions.addSiblingAfter(id);
      return;
    }

    // ---- Tab / Shift+Tab: indent / outdent ----
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) actions.outdent(id, field);
      else actions.indent(id, field);
      return;
    }

    // ---- Alt+Shift+Up/Down: reorder the bullet (Workflowy) ----
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.key === 'ArrowUp') actions.moveUp(id);
      else actions.moveDown(id);
      return;
    }

    // ---- Vertical navigation across bullets and fields ----
    if (e.key === 'ArrowUp' && caretOnFirstLine(el)) {
      e.preventDefault();
      actions.moveFocus({ id, field }, -1);
      return;
    }
    if (e.key === 'ArrowDown' && caretOnLastLine(el)) {
      e.preventDefault();
      actions.moveFocus({ id, field }, 1);
      return;
    }

    // ---- Backspace at the very start ----
    if (e.key === 'Backspace' && caretAtStart(el)) {
      if (field === 'body') {
        e.preventDefault();
        actions.setFocus({ id, field: 'title', caret: 'end' });
        return;
      }
      // title: delete the bullet if it is completely empty
      if (bullet.title === '' && bullet.body === '' && bullet.children.length === 0) {
        e.preventDefault();
        actions.deleteBullet(id);
        return;
      }
    }
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>, field: Field) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      refreshMention(e.currentTarget, field);
    }
  }

  const hasChildren = bullet.children.length > 0;

  return (
    <div className="ol-row" style={{ marginLeft: depth * 22 }}>
      <div className="ol-gutter">
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
          onClick={() => actions.setFocus({ id, field: 'title', caret: 'end' })}
          tabIndex={-1}
          aria-label="Focus bullet"
        />
      </div>

      <div className="ol-fields">
        <div className="ol-field-wrap">
          <AutoTextarea
            id={id}
            field="title"
            value={bullet.title}
            className="ol-title"
            placeholder="Untitled"
            onChange={(e) => onChange(e, 'title')}
            onKeyDown={(e) => onKeyDown(e, 'title')}
            onKeyUp={(e) => onKeyUp(e, 'title')}
            onFocus={() => actions.select(id)}
          />
          {ac?.field === 'title' && <Dropdown ac={ac} onPick={(m) => accept('title', m)} />}
        </div>

        {(bullet.body !== '' || isFocused(id, 'body')) && (
          <div className="ol-field-wrap">
            <AutoTextarea
              id={id}
              field="body"
              value={bullet.body}
              className="ol-body"
              placeholder="Notes…"
              onChange={(e) => onChange(e, 'body')}
              onKeyDown={(e) => onKeyDown(e, 'body')}
              onKeyUp={(e) => onKeyUp(e, 'body')}
              onFocus={() => actions.select(id)}
            />
            {ac?.field === 'body' && <Dropdown ac={ac} onPick={(m) => accept('body', m)} />}
          </div>
        )}
      </div>
    </div>
  );
}

function isFocused(id: string, field: Field): boolean {
  const f = getState().focus;
  return !!f && f.id === id && f.field === field;
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
  field: Field;
  value: string;
  className: string;
  placeholder: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
}

/** Textarea that grows to fit its content and registers itself for focus. */
function AutoTextarea({ id, field, value, className, placeholder, ...handlers }: AutoProps) {
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
        register(id, field, el);
      }}
      value={value}
      rows={1}
      spellCheck={false}
      className={className}
      placeholder={placeholder}
      {...handlers}
    />
  );
}
