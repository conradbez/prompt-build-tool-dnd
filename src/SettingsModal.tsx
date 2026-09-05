import { useEffect } from 'react';
import { PROVIDERS, type Provider } from './api';
import { NAME_RE, setPromptVars, usePromptVars, type PromptVar } from './lib/promptdata';

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
            <p className="res-col__note">
              Kept in this browser, one key per provider. Leave it empty to use the key the server
              was started with.
            </p>
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
              // A name is only a problem once it has been typed: the blank last
              // row is the norm, not an error.
              const badName = row.name !== '' && !NAME_RE.test(row.name);
              const duplicate = row.name !== '' && names.indexOf(row.name) !== i;
              return (
                <tr key={i}>
                  <td>
                    <input
                      className={`pd-input pd-input--name${
                        badName || duplicate ? ' pd-input--bad' : ''
                      }`}
                      value={row.name}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={i === rows.length - 1 ? 'tone' : ''}
                      title={
                        badName
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
                      placeholder={i === rows.length - 1 ? 'formal, and never chatty' : ''}
                      onChange={(e) => edit(i, { value: e.target.value })}
                    />
                  </td>
                  <td>
                    {i < rows.length - 1 && (
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
      </p>
    </section>
  );
}
