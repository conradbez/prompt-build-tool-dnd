import { useState } from 'react';
import { PROVIDERS, runGraph, SERVER_URL_STORAGE, type Provider } from './api';
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
 * (this browser only). The ⚙ button reveals an optional server URL — set it to
 * your Railway URL for a deployed build (fixes a 405 from a static host).
 */
export function Toolbar() {
  const state = useOutline();
  const [provider, setProvider] = useState<Provider>(loadProvider);
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(keyStorage(loadProvider())) || '');
  const [showSettings, setShowSettings] = useState(false);
  const [serverUrl, setServerUrl] = useState<string>(() => localStorage.getItem(SERVER_URL_STORAGE) || '');

  const onProviderChange = (p: Provider) => {
    setProvider(p);
    localStorage.setItem(PROVIDER_STORAGE, p);
    setApiKey(localStorage.getItem(keyStorage(p)) || '');
  };

  const onKeyChange = (v: string) => {
    setApiKey(v);
    localStorage.setItem(keyStorage(provider), v);
  };

  const onServerUrlChange = (v: string) => {
    setServerUrl(v);
    if (v.trim()) localStorage.setItem(SERVER_URL_STORAGE, v.trim());
    else localStorage.removeItem(SERVER_URL_STORAGE);
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
        <button
          className="tb__gear"
          onClick={() => setShowSettings((s) => !s)}
          aria-label="Server settings"
          title="Server settings"
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <div className="tb__row tb__row--settings">
          <input
            className="tb__server"
            type="url"
            placeholder="Server URL (e.g. https://app.up.railway.app) — blank = dev proxy"
            value={serverUrl}
            onChange={(e) => onServerUrlChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
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
