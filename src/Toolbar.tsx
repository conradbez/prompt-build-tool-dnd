import { useState } from 'react';
import { PROVIDERS, runGraph, type Provider } from './api';
import { SettingsModal } from './SettingsModal';
import { actions, buildNodePayloads, getState, useOutline } from './store';

const PROVIDER_STORAGE = 'wm.provider';
const GLOBAL_INSTRUCTION_STORAGE = 'wm.globalInstruction';
const keyStorage = (p: Provider) => `wm.apiKey.${p}`;

function loadProvider(): Provider {
  const v = localStorage.getItem(PROVIDER_STORAGE) as Provider | null;
  return v && PROVIDERS.some((p) => p.id === v) ? v : 'anthropic';
}

/**
 * Top-left controls: pick a provider, paste an API key, and Run the graph
 * through the pbt server. The key is remembered per provider in localStorage
 * (this browser only). The server is the page's own origin (see api.ts).
 */
export function Toolbar() {
  const state = useOutline();
  const [provider, setProvider] = useState<Provider>(loadProvider);
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(keyStorage(loadProvider())) || '');
  // Settings: one instruction the server prepends to every LLM call in a run.
  // Remembered here, sent with each run — the server keeps no state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [globalInstruction, setGlobalInstruction] = useState<string>(
    () => localStorage.getItem(GLOBAL_INSTRUCTION_STORAGE) || '',
  );

  const onInstructionChange = (v: string) => {
    setGlobalInstruction(v);
    localStorage.setItem(GLOBAL_INSTRUCTION_STORAGE, v);
  };

  const onProviderChange = (p: Provider) => {
    setProvider(p);
    localStorage.setItem(PROVIDER_STORAGE, p);
    setApiKey(localStorage.getItem(keyStorage(p)) || '');
  };

  const onKeyChange = (v: string) => {
    setApiKey(v);
    localStorage.setItem(keyStorage(provider), v);
  };

  const run = async () => {
    actions.setRunning(true);
    try {
      const nodes = buildNodePayloads(getState());
      const res = await runGraph(nodes, provider, apiKey, globalInstruction);
      actions.setRunResult(res.outputs || {}, res.errors || [], res.prompts || {});
    } catch (err) {
      actions.setRunResult(
        getState().results,
        [err instanceof Error ? err.message : String(err)],
        getState().prompts,
      );
    }
  };

  return (
    <div className="tb">
      <div className="tb__row">
        <select
          className="tb__select"
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
          className="tb__key"
          type="password"
          placeholder={`${provider} API key`}
          value={apiKey}
          onChange={(e) => onKeyChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button className="tb__run" onClick={run} disabled={state.running}>
          {state.running ? 'Running…' : 'Run'}
        </button>
        <button
          className={`tb__gear${settingsOpen ? ' tb__gear--on' : ''}${
            globalInstruction.trim() ? ' tb__gear--set' : ''
          }`}
          onClick={() => setSettingsOpen((v) => !v)}
          title="Settings"
          aria-label="Settings"
          aria-expanded={settingsOpen}
        >
          ⚙
        </button>
      </div>

      {settingsOpen && (
        <SettingsModal
          value={globalInstruction}
          onChange={onInstructionChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {state.runErrors.length > 0 && (
        <div className="tb__errors">
          {state.runErrors.map((e, i) => (
            <div key={i} className="tb__error">
              {e}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
