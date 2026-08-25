import { useState } from 'react';
import { PROVIDERS, runGraph, type Provider } from './api';
import { actions, buildNodePayloads, getState, useOutline } from './store';

const PROVIDER_STORAGE = 'wm.provider';
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
      const res = await runGraph(nodes, provider, apiKey);
      actions.setRunResult(res.outputs || {}, res.errors || []);
    } catch (err) {
      actions.setRunResult(getState().results, [err instanceof Error ? err.message : String(err)]);
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
      </div>

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
