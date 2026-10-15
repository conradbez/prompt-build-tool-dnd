import { useEffect, useState } from 'react';
import { PROVIDERS, runGraph, type ClassifierSettings, type Provider } from './api';
import { RunProgress } from './RunProgress';
import { SettingsModal } from './SettingsModal';
import { actions, buildNodePayloads, getState, useOutline } from './store';
import { NAME_RE, promptVarMap, usePromptVars } from './lib/promptdata';
import { SETTINGS_HINT } from './lib/shortcuts';
import { setAgent37Key, useAgent37Key } from './lib/agent37Key';
import { useAccount } from './lib/account';

const PROVIDER_STORAGE = 'wm.provider';
const GLOBAL_INSTRUCTION_STORAGE = 'wm.globalInstruction';
const keyStorage = (p: Provider) => `wm.apiKey.${p}`;
const CLASSIFIER_STORAGE = 'wm.classifier';
const AGENT_STEPS_STORAGE = 'wm.agentSteps';

function loadClassifier(): ClassifierSettings {
  const empty = { apiKey: '', baseUrl: '', model: '' };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(CLASSIFIER_STORAGE) || '{}') };
  } catch {
    return empty;
  }
}

function loadProvider(): Provider {
  const v = localStorage.getItem(PROVIDER_STORAGE) as Provider | null;
  return v && PROVIDERS.some((p) => p.id === v) ? v : 'anthropic';
}

/**
 * Bottom-left controls: Run the graph through the pbt server, and the gear to
 * everything else. The provider and key live in Settings; a run the server
 * refuses for want of a key asks for one in a popup instead, then runs. The
 * key is remembered per provider in localStorage (this browser only). The
 * server is the page's own origin (see api.ts).
 */
export function Toolbar() {
  const state = useOutline();
  const [provider, setProvider] = useState<Provider>(loadProvider);
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(keyStorage(loadProvider())) || '');
  // Settings: one instruction the server prepends to every LLM call in a run.
  // Remembered here, sent with each run — the server keeps no state.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Where Settings opens scrolled to: the Login button wants the account.
  const [settingsFocus, setSettingsFocus] = useState<'account' | undefined>();
  // Set when a run stopped for want of a key: the bullets it was asked to run
  // (`null` for the whole graph), so the key popup can run them once it has one.
  const [needsKey, setNeedsKey] = useState<{ select?: string[] } | null>(null);
  const account = useAccount();
  const [globalInstruction, setGlobalInstruction] = useState<string>(
    () => localStorage.getItem(GLOBAL_INSTRUCTION_STORAGE) || '',
  );
  // The variables keep themselves (see `lib/promptdata`); the toolbar only
  // sends them, and marks the gear when there is something behind it. The mark
  // counts the *rows a person wrote* — the reserved variables are always in the
  // map, and a dot that is always on says nothing.
  const [classifier, setClassifier] = useState<ClassifierSettings>(loadClassifier);
  // Steps an agent bullet may take; 0 leaves it to the server's default.
  const [agentSteps, setAgentSteps] = useState<number>(
    () => Number(localStorage.getItem(AGENT_STEPS_STORAGE)) || 0,
  );
  // The user's own Agent37 key; blank runs preserve-disk agents on the shared instance.
  const agent37Key = useAgent37Key();
  // Mod+, opens settings, as in most desktop apps; the browser leaves it to the
  // page once we take it, so it works in a tab too. On a bullet (caret in its
  // row, or its node clicked) it opens *that* bullet's settings; otherwise the
  // run's. Pressed again, it closes whichever is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key !== ',') return;
      e.preventDefault();
      const s = getState();
      if (settingsOpen) setSettingsOpen(false);
      else if (s.openResultId) actions.openResult(null);
      else if (s.focus && s.bullets[s.focus.id]) actions.openSettings(s.focus.id);
      else setSettingsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const rows = usePromptVars();
  const vars = promptVarMap(rows);
  const written = rows.filter((r) => NAME_RE.test(r.name)).length;

  const onInstructionChange = (v: string) => {
    setGlobalInstruction(v);
    localStorage.setItem(GLOBAL_INSTRUCTION_STORAGE, v);
  };

  const onClassifierChange = (v: ClassifierSettings) => {
    setClassifier(v);
    localStorage.setItem(CLASSIFIER_STORAGE, JSON.stringify(v));
  };

  const onAgentStepsChange = (v: number) => {
    setAgentSteps(v);
    localStorage.setItem(AGENT_STEPS_STORAGE, String(v));
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

  const openSettings = (focus?: 'account') => {
    setSettingsFocus(focus);
    setSettingsOpen(true);
  };

  // Lets a bullet's settings run just that bullet (see `actions.runNode`).
  useEffect(() => actions.setRunner((id) => run([id])));

  const statuses = Object.values(state.runStatus);
  const progress = {
    total: statuses.length,
    done: statuses.filter((s) => s !== 'queued' && s !== 'running').length,
    failed: statuses.filter((s) => s === 'error').length,
  };

  // `select` runs those bullets and what feeds them, keeping every other
  // bullet's last answer; without it the whole graph runs.
  const run = async (select?: string[], key = apiKey) => {
    actions.setRunning(true);
    try {
      const nodes = buildNodePayloads(getState());
      const res = await runGraph(
        nodes,
        provider,
        key,
        globalInstruction,
        vars,
        classifier,
        agentSteps,
        agent37Key,
        actions.runEvent,
        select,
      );
      if (res.needsKey) {
        // Nothing ran, so the last run's answers stand; the popup asks for a key.
        setNeedsKey({ select });
        const s = getState();
        actions.setRunResult(s.results, [], s.prompts, s.tests, s.files);
        return;
      }
      const s = getState();
      const keep = <T,>(prev: Record<string, T>, next: Record<string, T> | undefined) =>
        select ? { ...prev, ...next } : next || {};
      actions.setRunResult(
        keep(s.results, res.outputs),
        res.errors || [],
        keep(s.prompts, res.prompts),
        keep(s.tests, res.tests),
        keep(s.files, res.files),
      );
    } catch (err) {
      actions.setRunResult(
        getState().results,
        [err instanceof Error ? err.message : String(err)],
        getState().prompts,
        getState().tests,
        getState().files,
      );
    }
  };

  return (
    <div className="tb">
      <div className="tb__row">
        {!account && (
          <button className="tb__login" onClick={() => openSettings('account')}>
            Log in
          </button>
        )}
        <button className="tb__run" onClick={() => run()} disabled={state.running}>
          {state.running ? `Running ${progress.done}/${progress.total}…` : 'Run'}
        </button>
        {state.runLog.length > 0 && (
          <button
            className={`tb__log${progress.failed || state.runErrors.length ? ' tb__log--failed' : ''}${state.running ? ' tb__log--live' : ''}`}
            onClick={() => actions.openProgress(true)}
            title="Run progress and logs"
            aria-label="Run progress and logs"
          >
            ☰
          </button>
        )}
        <button
          className={`tb__gear${settingsOpen ? ' tb__gear--on' : ''}${
            globalInstruction.trim() || written ? ' tb__gear--set' : ''
          }`}
          onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
          title={`Settings (${SETTINGS_HINT})`}
          aria-label="Settings"
          aria-expanded={settingsOpen}
        >
          {/* U+FE0E: the text glyph, not iOS's colour emoji. */}
          {'⚙\uFE0E'}
        </button>
      </div>

      {settingsOpen && (
        <SettingsModal
          value={globalInstruction}
          onChange={onInstructionChange}
          onClose={() => setSettingsOpen(false)}
          focus={settingsFocus}
          provider={provider}
          apiKey={apiKey}
          onProviderChange={onProviderChange}
          onKeyChange={onKeyChange}
          classifier={classifier}
          onClassifierChange={onClassifierChange}
          agentSteps={agentSteps}
          onAgentStepsChange={onAgentStepsChange}
          agent37Key={agent37Key}
          onAgent37KeyChange={setAgent37Key}
        />
      )}

      {needsKey && (
        <KeyModal
          provider={provider}
          apiKey={apiKey}
          onProviderChange={onProviderChange}
          onKeyChange={onKeyChange}
          onClose={() => setNeedsKey(null)}
          onRun={() => {
            const { select } = needsKey;
            setNeedsKey(null);
            run(select, apiKey);
          }}
        />
      )}

      {state.progressOpen && <RunProgress />}
    </div>
  );
}

/**
 * Asked for when a run is refused for want of a key: the provider and its key,
 * then Run. The same state Settings edits, so a key entered here is there next
 * time, and changing it later is the gear's job, not this popup's.
 */
function KeyModal({
  provider,
  apiKey,
  onProviderChange,
  onKeyChange,
  onClose,
  onRun,
}: {
  provider: Provider;
  apiKey: string;
  onProviderChange: (p: Provider) => void;
  onKeyChange: (v: string) => void;
  onClose: () => void;
  onRun: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="res-modal" onClick={onClose} role="dialog" aria-modal="true">
      <form
        className="res-modal__panel res-modal__panel--narrow"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (apiKey.trim()) onRun();
        }}
      >
        <div className="res-modal__head">
          <h2 className="res-modal__title">Add an API key to run</h2>
          <button type="button" className="res-modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="key-modal">
          <p className="key-modal__note">
            This server has no key of its own for this provider. Yours stays in this browser; change
            it any time in Settings.
          </p>
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
            autoFocus
            onChange={(e) => onKeyChange(e.target.value)}
          />
          <button className="tb__run key-modal__run" type="submit" disabled={!apiKey.trim()}>
            Run
          </button>
        </div>
      </form>
    </div>
  );
}
