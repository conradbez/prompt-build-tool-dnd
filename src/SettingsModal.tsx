import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, exportGraph, type ExportTarget, type Provider } from './api';
import {
  NAME_RE,
  promptVarMap,
  reservedVar,
  setPromptVars,
  usePromptVars,
  type PromptVar,
} from './lib/promptdata';
import {
  BEFORE_LOAD,
  cleanName,
  hasSave,
  listSaves,
  readSave,
  setOpenSave,
  useOpenSave,
  writeSave,
} from './lib/saves';
import {
  actions,
  buildNodePayloads,
  currentDoc,
  docJson,
  getState,
  parseDoc,
  type Doc,
} from './store';

/** The "new name…" sentinel in the save dropdown — not a document name. */
const NEW_NAME = '\u0000new';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  /** Which provider runs the graph, and the key for it — see `Toolbar`. */
  provider: Provider;
  apiKey: string;
  onProviderChange: (p: Provider) => void;
  onKeyChange: (v: string) => void;
}

/**
 * Run settings, in the same panel the answer modal uses: click-outside and
 * Escape close it, and what you type is saved as you type — there is nothing
 * to confirm, so the modal has no buttons of its own.
 *
 * Everything a run needs that is not the graph itself: the provider and its
 * key, the global instruction the server renders into every prompt bullet
 * (pbt's `global_instruction`), and the run variables it hands to pbt as
 * `promptdata`.
 *
 * The provider and key are *also* in the toolbar on a wide screen, both views
 * of the one piece of state. On a narrow one the toolbar drops them (there is
 * no room for a select, a key field, Run and the gear at once) and this is
 * where they live — which is why they are here rather than only there.
 */
export function SettingsModal({
  value,
  onChange,
  onClose,
  provider,
  apiKey,
  onProviderChange,
  onKeyChange,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="res-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="res-modal__panel res-modal__panel--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="res-modal__head">
          <h2 className="res-modal__title">Settings</h2>
          <button className="res-modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="res-modal__cols">
          <section className="res-col">
            <h3 className="res-col__head">Model</h3>
            <div className="res-col__body pd-model">
              <select
                className="pd-select"
                value={provider}
                onChange={(e) => onProviderChange(e.target.value as Provider)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                className="pd-input"
                type="password"
                placeholder={`${provider} API key`}
                value={apiKey}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => onKeyChange(e.target.value)}
              />
            </div>
          </section>

          <section className="res-col">
            <h3 className="res-col__head">Global instruction prepended to every LLM call</h3>
            <textarea
              className="res-col__edit"
              value={value}
              spellCheck={false}
              placeholder="e.g. Answer in British English, and keep it under 200 words."
              onChange={(e) => onChange(e.target.value)}
            />
            <p className="res-col__note">
              Template and python bullets are left alone — only prompts get it.
            </p>
          </section>

          <VarTable />

          <Documents provider={provider} globalInstruction={value} />
        </div>
      </div>
    </div>
  );
}

/**
 * The run variables. There is no "add row" button: the table always ends in a
 * blank row, and typing in it makes the next one — so a table you are filling
 * in never asks you to stop and click something first.
 *
 * A row is dropped by clearing both of its fields, which is also what the ×
 * does. Nothing here is confirmed; the table is the state.
 *
 * The reserved rows sit at the top and are the exception: the server looks them
 * up by name, so their names are fixed and they cannot be removed — only their
 * values are yours. They are in the table rather than hidden behind a footnote
 * because a variable you cannot see is one you cannot set.
 */
function VarTable() {
  const rows = usePromptVars();

  // Every write goes through `setPromptVars`, which re-establishes the blank
  // last row — so typing in it grows the table, and clearing a row removes it.
  const edit = (i: number, patch: Partial<PromptVar>) =>
    setPromptVars(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const names = rows.map((r) => r.name);

  return (
    <section className="res-col">
      <h3 className="res-col__head">
        Variables — write <code>@name</code> in a bullet
      </h3>
      <div className="res-col__body pd-body">
        <table className="pd-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const fixed = reservedVar(row.name);
              // A name is only a problem once it has been typed: the blank last
              // row is the norm, not an error.
              const badName = !fixed && row.name !== '' && !NAME_RE.test(row.name);
              const duplicate = !fixed && row.name !== '' && names.indexOf(row.name) !== i;
              const last = i === rows.length - 1;
              return (
                <tr key={fixed ? row.name : i}>
                  <td>
                    <input
                      className={`pd-input pd-input--name${
                        badName || duplicate ? ' pd-input--bad' : ''
                      }${fixed ? ' pd-input--fixed' : ''}`}
                      value={row.name}
                      readOnly={!!fixed}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={last ? 'tone' : ''}
                      title={
                        fixed
                          ? `${fixed.hint} The name is fixed — the server looks it up by it.`
                          : badName
                            ? 'Letters, digits and underscores only'
                            : duplicate
                              ? 'Already used above — the first one wins'
                              : undefined
                      }
                      onChange={(e) => edit(i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="pd-input"
                      value={row.value}
                      spellCheck={false}
                      autoComplete="off"
                      title={fixed?.hint}
                      placeholder={
                        fixed ? fixed.placeholder : last ? 'formal, and never chatty' : ''
                      }
                      onChange={(e) => edit(i, { value: e.target.value })}
                    />
                  </td>
                  <td>
                    {!fixed && !last && (
                      <button
                        className="pd-x"
                        aria-label={`Remove ${row.name || 'this variable'}`}
                        title="Remove this variable"
                        onClick={() => setPromptVars(rows.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="res-col__note">
        Sent to pbt as <code>promptdata</code>: each <code>@name</code> in a bullet becomes{' '}
        <code>{'{{ promptdata("name") }}'}</code>. Renaming one here does not rewrite the bullets
        that used the old name.
        <br />
        The first two are the server&rsquo;s own: it reads them by name, so those cannot be
        renamed or removed — only filled in. Hover either for what it does.
      </p>
    </section>
  );
}

/**
 * Save, load and export the document.
 *
 * Saves live in this browser under a name (see `lib/saves`); exports are built
 * by the server from the same sources a run uses, so what you take away is what
 * was running. Loading is the one destructive action here, so it confirms first
 * and stashes what it displaced.
 */
function Documents({
  provider,
  globalInstruction,
}: {
  provider: Provider;
  globalInstruction: string;
}) {
  const [names, setNames] = useState<string[]>(() => listSaves());
  /** The save this map *is* — edits go back into it. Null until one is opened. */
  const open = useOpenSave();
  // The empty string is "no save chosen yet"; NEW_NAME reveals the text box.
  const [chosen, setChosen] = useState<string>(() => listSaves()[0] ?? NEW_NAME);
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which destructive action is one click from happening. The confirmation is
   * the button turning into the question — not a browser dialog, which stops
   * the whole page and reads as an error rather than a choice.
   */
  const [pending, setPending] = useState<null | 'save' | 'load' | 'paste'>(null);
  /** The clipboard document read on the first click of a two-step paste. */
  const [pasted, setPasted] = useState<Doc | null>(null);
  /**
   * Which menu is open. There are two verbs here — putting this map somewhere,
   * and bringing one back — and everything else is a choice of *where*: a named
   * save, a pbt project, the clipboard. Four buttons in a row made those look
   * like four unrelated things.
   */
  const [menu, setMenu] = useState<null | 'save' | 'load'>(null);
  const section = useRef<HTMLElement | null>(null);

  /**
   * A question lapses. While one is pending the button *is* the confirmation,
   * so a question left standing turns a later click — one meant to open the
   * menu — into the answer. Ten seconds is long enough to read it and short
   * enough that it is never a surprise.
   */
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => {
      reset();
      setStatus(null);
    }, 10000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // A click anywhere else puts an open menu away — including on the other
  // menu's button, which then opens on the same click.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!section.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);
  /**
   * Shown when the browser will not hand over the clipboard. Reading it needs a
   * permission some browsers refuse, some never answer, and Firefox does not
   * implement at all — and a button that silently does nothing is the worst of
   * the outcomes. A box you paste into always works.
   */
  const [pasteBox, setPasteBox] = useState<string | null>(null);

  const naming = chosen === NEW_NAME || names.length === 0;
  const name = cleanName(naming ? typed : chosen);

  const say = (text: string, bad = false) => setStatus({ text, bad });

  /** Any click that is not the second half of a confirmation cancels it. */
  const reset = () => {
    setPending(null);
    setPasted(null);
    setPasteBox(null);
  };

  /** Run a menu item, and put the menu away. */
  const pick = (fn: () => void) => {
    setMenu(null);
    fn();
  };

  /** Do the button's own thing, and put away a menu opened beside it. */
  const act = (fn: () => void) => {
    setMenu(null);
    fn();
  };

  /** Open (or close) a menu. Reaching for it is changing your mind about any
   *  question left standing on the button beside it. */
  const openMenu = (which: 'save' | 'load') => {
    reset();
    setStatus(null);
    setMenu(menu === which ? null : which);
  };

  function onSave() {
    if (!name) return say('Give it a name first.', true);
    if (hasSave(name) && pending !== 'save') {
      setPending('save');
      return say(`“${name}” already exists — click again to replace it.`);
    }
    reset();
    if (!writeSave(name, currentDoc(getState()))) {
      return say('This browser refused the save — storage may be full.', true);
    }
    setOpenSave(name);
    setNames(listSaves());
    setChosen(name);
    setTyped('');
    say(`Saved as “${name}”. Changes from here go into it as you make them.`);
  }

  function onLoad() {
    if (naming || !chosen) return say('Pick a saved document to load.', true);
    const doc = readSave(chosen);
    if (!doc) return say(`“${chosen}” could not be read.`, true);
    if (pending !== 'load') {
      setPending('load');
      return say(
        `This replaces what is on screen with “${chosen}” — click again to go ahead. ` +
          `The current map is kept as “${BEFORE_LOAD}”.`,
      );
    }
    reset();
    writeSave(BEFORE_LOAD, currentDoc(getState()));
    actions.replaceDoc(doc);
    setOpenSave(chosen);
    setNames(listSaves());
    say(`Loaded “${chosen}”. The map it replaced is saved as “${BEFORE_LOAD}”.`);
  }

  async function onExport(target: ExportTarget) {
    reset();
    setBusy(true);
    try {
      const result = await exportGraph(
        target,
        name || 'mindmap',
        buildNodePayloads(getState()),
        provider,
        globalInstruction,
        promptVarMap(),
      );
      if (result.errors.length) return say(result.errors.join(' '), true);
      download(result.filename, result.text);
      say(
        result.warnings.length
          ? `${result.filename} — ${result.warnings.join(' ')}`
          : `Downloaded ${result.filename}.`,
        result.warnings.length > 0,
      );
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    reset();
    try {
      await navigator.clipboard.writeText(docJson(getState()));
      say('The document is on the clipboard, as JSON.');
    } catch {
      say('This browser would not give the clipboard — copy is blocked here.', true);
    }
  }

  async function onPaste() {
    if (pending === 'paste' && pasted) {
      reset();
      writeSave(BEFORE_LOAD, currentDoc(getState()));
      actions.replaceDoc(pasted);
      // A pasted map is not any of the saves, so nothing is open: it is saved
      // when you name it, not before.
      setOpenSave(null);
      setNames(listSaves());
      return say(`Loaded from the clipboard. The map it replaced is saved as “${BEFORE_LOAD}”.`);
    }
    let text: string;
    try {
      text = await readClipboard();
    } catch {
      setPasteBox('');
      return say('This browser would not hand over the clipboard — paste it in here instead.');
    }
    const doc = parseDoc(text);
    if (!doc) return say('That is not a document — the clipboard held something else.', true);
    // Read now, apply on the next click: the read needs this click's gesture,
    // and the replacement needs an answer to a question not yet asked.
    setPasted(doc);
    setPending('paste');
    const count = Object.keys(doc.bullets).length;
    say(
      `The clipboard holds a ${count}-bullet map. Click again to put it on screen — ` +
        `the current one is kept as “${BEFORE_LOAD}”.`,
    );
  }

  return (
    <section className="res-col" ref={section}>
      <h3 className="res-col__head">This map — save, load, export</h3>
      <div className="res-col__body pd-docs">
        <div className="pd-row">
          <select
            className="pd-select pd-select--wide"
            value={names.length === 0 ? NEW_NAME : chosen}
            onChange={(e) => {
              reset();
              setMenu(null);
              setChosen(e.target.value);
            }}
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={NEW_NAME}>New name…</option>
          </select>
          {naming && (
            <input
              className="pd-input"
              value={typed}
              placeholder="Name this map"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                reset();
                setMenu(null);
                setTyped(e.target.value);
              }}
            />
          )}
          {/* Split: the button does the ordinary thing — keep this map here,
              bring that one back — and the caret is where the same verb points
              somewhere else. The caret points up because the menu opens up. */}
          <div className="pd-menu pd-split">
            <button
              className={`pd-btn ${pending === 'save' ? 'pd-btn--confirm' : ''}`}
              disabled={!name}
              title={`Save this map in this browser as “${name || '…'}”`}
              onClick={() => act(onSave)}
            >
              {pending === 'save' ? 'Replace?' : 'Save'}
            </button>
            <button
              className="pd-btn pd-btn--caret"
              aria-haspopup="menu"
              aria-expanded={menu === 'save'}
              aria-label="Other places to put this map"
              onClick={() => openMenu('save')}
            >
              ▴
            </button>
            {menu === 'save' && (
              <ul className="pd-pop" role="menu">
                <li>
                  <button
                    role="menuitem"
                    disabled={busy}
                    title="A single Python file: the models as a dict and pbt.async_run over them."
                    onClick={() => pick(() => onExport('script'))}
                  >
                    Export to pbt…
                  </button>
                </li>
                <li>
                  <button
                    role="menuitem"
                    disabled={busy}
                    title="A Python file that writes models/*.prompt and client.py — the layout `pbt serve` expects."
                    onClick={() => pick(() => onExport('project'))}
                  >
                    Export to server…
                  </button>
                </li>
                <li>
                  <button
                    role="menuitem"
                    title="The whole document as JSON."
                    onClick={() => pick(onCopy)}
                  >
                    Copy to clipboard
                  </button>
                </li>
              </ul>
            )}
          </div>

          <div className="pd-menu pd-split">
            <button
              className={`pd-btn ${pending === 'load' || pending === 'paste' ? 'pd-btn--confirm' : ''}`}
              disabled={naming && pending === null}
              title={naming ? 'Pick a saved map first' : `Put “${chosen}” on screen`}
              onClick={() => act(() => (pending === 'paste' ? void onPaste() : onLoad()))}
            >
              {pending === 'load' || pending === 'paste' ? 'Replace this map?' : 'Load'}
            </button>
            <button
              className="pd-btn pd-btn--caret"
              aria-haspopup="menu"
              aria-expanded={menu === 'load'}
              aria-label="Other places to load a map from"
              onClick={() => openMenu('load')}
            >
              ▴
            </button>
            {menu === 'load' && (
              <ul className="pd-pop" role="menu">
                <li>
                  <button
                    role="menuitem"
                    title="Replace this map with JSON on the clipboard."
                    onClick={() => pick(() => void onPaste())}
                  >
                    Load from clipboard
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>

        {pasteBox !== null && (
          <textarea
            className="pd-paste"
            value={pasteBox}
            autoFocus
            spellCheck={false}
            placeholder="Paste the document JSON here"
            onChange={(e) => {
              const text = e.target.value;
              setPasteBox(text);
              const doc = parseDoc(text);
              if (!doc) {
                setPasted(null);
                setPending(null);
                if (text.trim()) say('Not a document yet — that is not this app\u2019s JSON.', true);
                return;
              }
              setPasted(doc);
              setPending('paste');
              say(
                `A ${Object.keys(doc.bullets).length}-bullet map. ` +
                  `“Replace this map?” puts it on screen; the current one is kept as “${BEFORE_LOAD}”.`,
              );
            }}
          />
        )}

        {status && (
          <p className={`pd-status ${status.bad ? 'pd-status--bad' : ''}`}>{status.text}</p>
        )}
      </div>
      <p className="res-col__note">
        {open ? (
          <>
            Editing “{open}” — changes go into it as you make them.{' '}
          </>
        ) : (
          <>Nothing is open: save this map under a name and edits will go into it. </>
        )}
        Saves stay in this browser. Loading replaces what is on screen and keeps a copy as “
        {BEFORE_LOAD}”.
      </p>
    </section>
  );
}

/**
 * The clipboard, or a rejection — never a promise that hangs.
 *
 * `readText()` waits on a permission prompt, and a prompt that is dismissed,
 * suppressed or never shown leaves the promise pending forever: the button
 * looks broken and there is nothing to click. Losing the race is a refusal.
 */
function readClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) return Promise.reject(new Error('unsupported'));
  return Promise.race([
    navigator.clipboard.readText(),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), 2500),
    ),
  ]);
}

/** Hand the browser a file. Exports are files because they are meant to be run. */
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/x-python' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
