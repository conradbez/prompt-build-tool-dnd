import { useEffect, useRef, useState } from 'react';
import type { Bullet } from '../types';
import { actions } from '../store';

interface Props {
  bullet: Bullet;
}

/**
 * Workflowy-style `•••` control living in the row gutter. It sits in reserved
 * space (so revealing it never reflows the text) and is invisible until the
 * row is hovered — see `.ol-row:hover .ol-menu` in index.css. Clicking opens a
 * small action popup for the bullet.
 */
export function BulletMenu({ bullet }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { id } = bullet;

  // Close on an outside click or Escape while the popup is open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function run(fn: () => void) {
    fn();
    setOpen(false);
  }

  function focusNew(newId: string) {
    actions.setFocus({ id: newId, caret: 'end' });
  }

  return (
    <div className={`ol-menu ${open ? 'ol-menu--open' : ''}`} ref={ref}>
      <button
        className="ol-menu__btn"
        // Keep the caret where it is — opening the menu shouldn't blur the editor.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Bullet menu"
      >
        •••
      </button>

      {open && (
        <ul className="ol-menu__pop" role="menu">
          <li>
            <button role="menuitem" onClick={() => run(() => focusNew(actions.addChild(id)))}>
              Add child
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => focusNew(actions.addSiblingAfter(id)))}>
              Add bullet below
            </button>
          </li>
          <li>
            <button
              role="menuitem"
              title="Template nodes are not sent to the LLM — their text, with refs filled in, is the output."
              onClick={() => run(() => actions.toggleTemplate(id))}
            >
              {bullet.template ? 'Convert to prompt' : 'Convert to template'}
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.indent(id))}>
              Indent
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.outdent(id))}>
              Outdent
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.moveUp(id))}>
              Move up
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.moveDown(id))}>
              Move down
            </button>
          </li>
          {bullet.children.length > 0 && (
            <li>
              <button role="menuitem" onClick={() => run(() => actions.toggleCollapse(id))}>
                {bullet.collapsed ? 'Expand' : 'Collapse'}
              </button>
            </li>
          )}
          <li>
            <button
              role="menuitem"
              className="ol-menu__item--danger"
              onClick={() => run(() => actions.deleteBullet(id))}
            >
              Delete
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
