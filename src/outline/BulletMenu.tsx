import { useEffect, useRef, useState } from 'react';
import type { Bullet } from '../types';
import { actions, canTakeChild, getState } from '../store';
import { filesEnabled, uploadFile } from '../api';
import { ROW_KEYS } from '../lib/shortcuts';

interface Props {
  bullet: Bullet;
  /** Show the row's keyboard shortcuts beside their items — only where they
   *  are bound, i.e. the outline row. */
  shortcuts?: boolean;
}

/**
 * Workflowy-style `•••` control living in the row gutter. It sits in reserved
 * space (so revealing it never reflows the text) and is invisible until the
 * row is hovered — see `.ol-row:hover .ol-menu` in index.css. Clicking opens a
 * small action popup for the bullet.
 */
export function BulletMenu({ bullet, shortcuts = false }: Props) {
  const key = (k: keyof typeof ROW_KEYS) =>
    shortcuts ? <kbd className="ol-menu__key">{ROW_KEYS[k]}</kbd> : null;
  const [open, setOpen] = useState(false);
  const [canUpload, setCanUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const { id } = bullet;

  // Attaching is hidden without a bucket — there is nowhere to put the bytes.
  useEffect(() => {
    if (!open) return;
    let live = true;
    filesEnabled().then((yes) => live && setCanUpload(yes));
    return () => {
      live = false;
    };
  }, [open]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = ''; // so picking the same file again still fires
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      for (const file of chosen) {
        actions.attachFile(id, await uploadFile(id, file));
      }
    } catch (err) {
      actions.setRunResult({}, [err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  }

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

      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={onPick}
        aria-hidden="true"
        tabIndex={-1}
      />

      {open && (
        <ul className="ol-menu__pop" role="menu">
          <li>
            <button
              role="menuitem"
              title="Node type, JSON output, and what that type needs — python packages, an agent's MCP server."
              onClick={() => run(() => actions.openSettings(id))}
            >
              Settings…
            </button>
          </li>
          {canUpload && (
            <li>
              <button
                role="menuitem"
                title="Attach a file to this bullet — it is sent to the LLM with this bullet's prompt"
                onClick={() => run(() => picker.current?.click())}
              >
                {busy ? 'Uploading…' : 'Attach file…'}
              </button>
            </li>
          )}
          {canTakeChild(getState(), id) && (
            <li>
              <button role="menuitem" onClick={() => run(() => focusNew(actions.addChild(id)))}>
                Add child
              </button>
            </li>
          )}
          {canTakeChild(getState(), bullet.parentId) && (
            <li>
              <button role="menuitem" onClick={() => run(() => focusNew(actions.addSiblingAfter(id)))}>
                Add bullet below
                {key('addBelow')}
              </button>
            </li>
          )}
          <li>
            <button role="menuitem" onClick={() => run(() => actions.indent(id))}>
              Indent
              {key('indent')}
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.outdent(id))}>
              Outdent
              {key('outdent')}
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.moveUp(id))}>
              Move up
              {key('moveUp')}
            </button>
          </li>
          <li>
            <button role="menuitem" onClick={() => run(() => actions.moveDown(id))}>
              Move down
              {key('moveDown')}
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
