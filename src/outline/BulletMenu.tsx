import { useEffect, useRef, useState } from 'react';
import type { Bullet } from '../types';
import { actions, canTakeChild, getState } from '../store';
import { filesEnabled, pythonEnabled, uploadFile } from '../api';

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
  const [canUpload, setCanUpload] = useState(false);
  const [canPython, setCanPython] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const { id } = bullet;

  // Attaching is hidden without a bucket — there is nowhere to put the bytes.
  // `python` is only *annotated*, never hidden: this check fails on a stale or
  // unreachable server too, and a silently missing menu item is a worse bug
  // than a bullet that runs and reports what the server is missing.
  useEffect(() => {
    if (!open) return;
    let live = true;
    filesEnabled().then((yes) => live && setCanUpload(yes));
    pythonEnabled().then((yes) => live && setCanPython(yes));
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
              </button>
            </li>
          )}
          {bullet.kind !== 'prompt' && (
            <li>
              <button
                role="menuitem"
                title="An ordinary bullet: its text is sent to the LLM."
                onClick={() => run(() => actions.setKind(id, 'prompt'))}
              >
                Convert to prompt
              </button>
            </li>
          )}
          {bullet.kind !== 'template' && (
            <li>
              <button
                role="menuitem"
                title="Template nodes are not sent to the LLM — their text, with refs filled in, is the output."
                onClick={() => run(() => actions.setKind(id, 'template'))}
              >
                Convert to template
              </button>
            </li>
          )}
          {bullet.kind !== 'python' && (
            <li>
              <button
                role="menuitem"
                title={
                  canPython
                    ? 'Python nodes take no text of their own — they run the code their one child produced, in a Modal sandbox, and whatever it prints is the output.'
                    : 'Python nodes run their child\u2019s code in a Modal sandbox, which this server has not reported as configured — running one will say what is missing.'
                }
                onClick={() => run(() => actions.setKind(id, 'python'))}
              >
                Convert to python{canPython ? '' : ' (server not ready)'}
              </button>
            </li>
          )}
          <li>
            <button
              role="menuitem"
              title={
                bullet.jsonOutput
                  ? 'Stop checking this answer — anything it says will be passed on as it is.'
                  : 'Require JSON: the answer is parsed and validated, and an answer that is not JSON fails this bullet instead of flowing on as prose.'
              }
              onClick={() => run(() => actions.setJsonOutput(id, !bullet.jsonOutput))}
            >
              {bullet.jsonOutput ? 'Stop enforcing JSON' : 'Enforce JSON output'}
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
