import { useEffect, useState } from 'react';
import { SWITCH_HINT } from './lib/shortcuts';

interface Row {
  keys: string;
  desc: string;
}

const VIEW: Row[] = [
  { keys: SWITCH_HINT, desc: 'Switch between the mind map and the outline' },
  { keys: 'Click the thumbnail', desc: 'Same thing — or the ⇄ button above it (top right)' },
];

const EDITING: Row[] = [
  { keys: 'Enter', desc: 'New bullet below' },
  { keys: 'Shift + Enter', desc: 'New line inside this bullet' },
  { keys: 'Tab / Shift + Tab', desc: 'Indent / outdent (nest under, or lift out of, a bullet)' },
  { keys: 'Alt + Shift + ↑ / ↓', desc: 'Reorder the bullet among its siblings (Workflowy-style)' },
  { keys: '↑ / ↓', desc: 'Move the caret to the previous / next bullet' },
  { keys: 'Backspace', desc: 'At the start of an empty bullet → delete it' },
];

const MAP: Row[] = [
  { keys: 'Click a node', desc: 'Focus that bullet in the outline (and vice-versa)' },
  { keys: '＋ on a node', desc: 'Add a child node — a child feeds its output up into this node' },
  { keys: 'Drag a node', desc: 'Move it — the node then keeps that spot instead of following the layout' },
  { keys: 'Drag from ＋', desc: 'Link to another node; drop on empty canvas to make a new child there' },
  { keys: 'Click a link, Backspace', desc: 'Solid link → detach the child to top level; dashed link → remove the reference (on touch, tap the link)' },
  { keys: 'Drag / scroll / pinch', desc: 'Pan and zoom the map' },
];

const RUNNING: Row[] = [
  { keys: 'Provider + key + Run', desc: 'Runs the graph through prompt-build-tool and shows each result under its node' },
  { keys: '@Bullet', desc: 'Reference another (non-child) node — its output is included in this prompt (a dashed link appears)' },
  { keys: 'Children', desc: "A node auto-includes its children's outputs — they feed up into the parent, no @ needed. The bullet's own text comes first, then each child's output below it" },
  { keys: 'An empty bullet', desc: 'Kept, not skipped, when anything below it has text — a blank bullet just hands its children\u2019s outputs upward' },
  { keys: '••• → Convert to template', desc: 'TPL — not sent to the LLM: the text, with every reference filled in, is the output' },
  { keys: '••• → Convert to python', desc: 'PY — takes no text of its own: it runs the code its one child produced, in a sandbox, and whatever that prints is its output' },
];

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="help__section">
      <h3 className="help__h3">{title}</h3>
      <dl className="help__list">
        {rows.map((r) => (
          <div className="help__item" key={r.keys}>
            <dt className="help__keys">{r.keys}</dt>
            <dd className="help__desc">{r.desc}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Floating "?" button (bottom-right) that opens a shortcuts & syntax dialog. */
export function Help() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button className="help__fab" onClick={() => setOpen(true)} aria-label="Shortcuts and syntax">
        ?
      </button>

      {open && (
        <div className="help__overlay" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
          <div className="help__panel" onClick={(e) => e.stopPropagation()}>
            <div className="help__head">
              <h2 className="help__title">Shortcuts &amp; syntax</h2>
              <button className="help__close" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <Section title="Switching view" rows={VIEW} />
            <Section title="Editing bullets" rows={EDITING} />
            <Section title="Mind map" rows={MAP} />
            <Section title="Running &amp; references" rows={RUNNING} />
          </div>
        </div>
      )}
    </>
  );
}
