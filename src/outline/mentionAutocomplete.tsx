import { useState } from 'react';
import { actions, getState } from '../store';
import type { Bullet } from '../types';
import { applyMention, applyVar, detectMention, type TitleMap } from '../lib/mentions';
import type { PromptVarMap } from '../lib/promptdata';

/**
 * A completion offered under an `@`: either another bullet, whose output flows
 * into this one, or a run variable from Settings, which is substituted in.
 * They share the trigger because they read the same way in a sentence; the
 * dropdown and the text colour them apart.
 */
export interface Match {
  kind: 'bullet' | 'var';
  /** The bullet's id, or the variable's name. */
  id: string;
  /** Shown in the dropdown. */
  title: string;
}

export interface AutocompleteState {
  start: number;
  index: number;
  matches: Match[];
}

const MAX_MATCHES = 8;

/**
 * The `@` autocomplete for one bullet's text, shared by every editor of it —
 * the outline row and the node popup — so a mention can be added from either,
 * whatever the bullet's kind.
 *
 * `getEl` returns the textarea being typed in; it holds the display form.
 */
export function useMentionAutocomplete(
  bullet: Bullet,
  titles: TitleMap,
  vars: PromptVarMap,
  getEl: () => HTMLTextAreaElement | null,
) {
  const [ac, setAc] = useState<AutocompleteState | null>(null);
  const { id } = bullet;

  function findMatches(query: string): Match[] {
    // Variables lead: there are a handful of them against every bullet in the
    // document, and an exact name is what someone typing `@tone` meant.
    const varMatches: Match[] = Object.keys(vars)
      .filter((n) => n.toLowerCase().includes(query))
      .map((n): Match => ({ kind: 'var', id: n, title: n }));
    const bullets: Match[] = Object.values(getState().bullets)
      .filter((b) => b.id !== id && (titles[b.id] || '').toLowerCase().includes(query))
      .map((b): Match => ({ kind: 'bullet', id: b.id, title: titles[b.id] || 'Untitled' }));
    return [...varMatches, ...bullets].slice(0, MAX_MATCHES);
  }

  function refresh(el: HTMLTextAreaElement) {
    const m = detectMention(el.value, el.selectionStart);
    const matches = m ? findMatches(m.query) : [];
    setAc(m && matches.length ? { start: m.start, index: 0, matches } : null);
  }

  function accept(match: Match) {
    const el = getEl();
    if (!el || !ac) return;
    // For a bullet the id — not the text — is what gets stored, so editing the
    // target later just changes how the mention reads. A variable is stored as
    // the `@name` you see: its name is its identity.
    const { raw, caret } =
      match.kind === 'var'
        ? applyVar(el.value, bullet.text, ac.start, el.selectionStart, match.id, titles)
        : applyMention(
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
      const el2 = getEl();
      if (el2) {
        el2.focus();
        el2.setSelectionRange(caret, caret);
      }
    });
  }

  /** Keys the open dropdown takes first. True when one was handled. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!ac || ac.matches.length === 0) return false;
    const n = ac.matches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setAc({ ...ac, index: (ac.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(ac.matches[ac.index]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Stop here, so Escape closes the dropdown and not the popup around it.
      e.stopPropagation();
      setAc(null);
      return true;
    }
    return false;
  }

  /** Caret moves without typing can enter or leave an `@query`. */
  function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) refresh(e.currentTarget);
  }

  return { ac, refresh, accept, onKeyDown, onKeyUp, close: () => setAc(null) };
}

export function MentionDropdown({ ac, onPick }: { ac: AutocompleteState; onPick: (m: Match) => void }) {
  return (
    <ul className="ol-ac">
      {ac.matches.map((m, i) => (
        <li
          key={`${m.kind}:${m.id}`}
          className={`ol-ac__item ol-ac__item--${m.kind} ${
            i === ac.index ? 'ol-ac__item--active' : ''
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(m);
          }}
        >
          @{m.title}
          {m.kind === 'var' && <span className="ol-ac__tag">variable</span>}
        </li>
      ))}
    </ul>
  );
}
