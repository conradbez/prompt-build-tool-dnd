import { useEffect, useState } from 'react';
import { agentEnabled, pythonInfo } from './api';
import { actions, firstLine } from './store';
import type { Bullet, BulletKind } from './types';

interface Props {
  bullet: Bullet;
}

const KINDS: { kind: BulletKind; label: string; desc: string }[] = [
  { kind: 'prompt', label: 'Prompt', desc: 'Its text, with its inputs filled in, is sent to the LLM.' },
  {
    kind: 'template',
    label: 'Template',
    desc: 'Never sent to the LLM — its text, with every reference filled in, is the output.',
  },
  {
    kind: 'python',
    label: 'Python',
    desc: 'Takes no text of its own: runs the code its one child produced in a Modal sandbox, and whatever that prints is the output.',
  },
  {
    kind: 'agent',
    label: 'Agent',
    desc: 'Its text is a task for a coding agent in a Modal sandbox, working with bash — and an MCP server’s tools, if you set one.',
  },
  {
    kind: 'test',
    label: 'Test',
    desc: 'Its text is an assertion about the bullets connected into it. Green passed, red failed, grey not run.',
  },
];

/**
 * One bullet's settings: what it is, and everything that only makes sense for
 * that kind — JSON enforcement, a python bullet's sandbox packages, an agent's
 * MCP server. Like the run settings, it saves as you type and has no buttons.
 */
export function NodeSettingsModal({ bullet }: Props) {
  const close = () => actions.openSettings(null);
  const [python, setPython] = useState({ enabled: true, packages: [] as string[] });
  const [agent, setAgent] = useState(true);
  const { id, kind } = bullet;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    let live = true;
    pythonInfo().then((info) => live && setPython(info));
    agentEnabled().then((yes) => live && setAgent(yes));
    return () => {
      live = false;
    };
  }, []);

  const current = KINDS.find((k) => k.kind === kind)!;
  const title = firstLine(bullet.text) || (kind === 'python' ? 'Python' : 'Untitled');
  const notReady =
    (kind === 'python' && !python.enabled) || (kind === 'agent' && !agent)
      ? ' This server has not reported Modal as configured — running it will say what is missing.'
      : '';

  return (
    <div className="res-modal" onClick={close} role="dialog" aria-modal="true">
      <div
        className="res-modal__panel res-modal__panel--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="res-modal__head">
          <h2 className="res-modal__title" title={title}>
            Settings — {title}
          </h2>
          <button className="res-modal__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="res-modal__cols">
          <section className="res-col">
            <h3 className="res-col__head">Node type</h3>
            <div className="res-col__body">
              <div className="ns-kinds" role="radiogroup" aria-label="Node type">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    role="radio"
                    aria-checked={kind === k.kind}
                    className={`ns-kind ${kind === k.kind ? 'ns-kind--on' : ''}`}
                    title={
                      k.kind === 'python' && bullet.text.trim()
                        ? `${k.desc} Its current text will be cleared.`
                        : k.desc
                    }
                    onClick={() => actions.setKind(id, k.kind)}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="res-col__note">
              {current.desc}
              {notReady}
            </p>
          </section>

          {kind !== 'test' && (
            <section className="res-col">
              <h3 className="res-col__head">Output</h3>
              <div className="res-col__body">
                <label className="ns-check">
                  <input
                    type="checkbox"
                    checked={bullet.jsonOutput}
                    onChange={(e) => actions.setJsonOutput(id, e.target.checked)}
                  />
                  Enforce JSON output
                </label>
              </div>
              <p className="res-col__note">
                The answer is parsed and validated (pbt&rsquo;s <code>output_format="json"</code>);
                one that is not JSON fails this bullet instead of flowing on as prose.
              </p>
            </section>
          )}

          {kind === 'test' && (
            <section className="res-col">
              <h3 className="res-col__head">Judge</h3>
              <div className="res-col__body">
                <div className="ns-kinds" role="radiogroup" aria-label="Judge">
                  {(['llm', 'classifier'] as const).map((j) => (
                    <button
                      key={j}
                      role="radio"
                      aria-checked={bullet.judge === j}
                      className={`ns-kind ${bullet.judge === j ? 'ns-kind--on' : ''}`}
                      onClick={() => actions.setJudge(id, j)}
                    >
                      {j === 'llm' ? 'LLM' : 'Classifier'}
                    </button>
                  ))}
                </div>
                {bullet.judge === 'classifier' && (
                  <label className="ns-check">
                    Pass when P(yes) ≥
                    <input
                      className="pd-input"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={bullet.threshold}
                      style={{ width: '6em' }}
                      onChange={(e) => actions.setThreshold(id, e.target.valueAsNumber)}
                    />
                  </label>
                )}
              </div>
              <p className="res-col__note">
                {bullet.judge === 'llm'
                  ? 'The run’s model reads the assertion and what is connected, and answers pass or fail.'
                  : 'No LLM: the assertion is asked as a yes/no question about what is connected, and the classifier set in Settings answers with a probability.'}
              </p>
            </section>
          )}

          {kind === 'python' && (
            <section className="res-col">
              <h3 className="res-col__head">Sandbox packages</h3>
              <div className="res-col__body">
                <input
                  className="pd-input"
                  value={bullet.packages}
                  placeholder="beautifulsoup4, lxml, scipy==1.*"
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                  onChange={(e) => actions.setPackages(id, e.target.value)}
                />
              </div>
              <p className="res-col__note">
                Comma-separated, installed before this bullet runs
                {python.packages.length
                  ? ` on top of what the sandbox has: ${python.packages.join(', ')}.`
                  : '.'}{' '}
                A script can also ask for its own with a PEP 723 header.
              </p>
            </section>
          )}

          {kind === 'agent' && (
            <section className="res-col">
              <h3 className="res-col__head">MCP server</h3>
              <div className="res-col__body">
                <input
                  className="pd-input ns-mono"
                  value={bullet.mcpServer}
                  placeholder="uvx some-mcp-server"
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                  onChange={(e) => actions.setMcpServer(id, e.target.value)}
                />
              </div>
              <p className="res-col__note">
                The command that starts a stdio MCP server in the agent&rsquo;s sandbox, e.g.{' '}
                <code>uvx some-mcp-server</code> or <code>npx -y @scope/server</code>. Empty means
                none — the agent works with bash alone.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
