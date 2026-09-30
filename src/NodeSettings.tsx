import { useEffect, useState } from 'react';
import { Info } from './Info';
import { agentEnabled, pythonInfo } from './api';
import { matchMcpServers } from './lib/mcpServers';
import { actions } from './store';
import type { Bullet, BulletKind } from './types';

interface Props {
  bullet: Bullet;
}

const KINDS: { kind: BulletKind; label: string; desc: string }[] = [
  {
    kind: 'prompt',
    label: 'Prompt',
    desc: 'Its text, with its inputs filled in, is sent to the LLM.',
  },
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
 * MCP server. Shown in the node modal's expander above its text, input and
 * response. Saves as you type and has no buttons.
 */
export function NodeSettings({ bullet }: Props) {
  const [python, setPython] = useState({
    enabled: true,
    packages: [] as string[],
  });
  const [agent, setAgent] = useState(true);
  const { id, kind } = bullet;

  useEffect(() => {
    let live = true;
    pythonInfo().then((info) => live && setPython(info));
    agentEnabled().then((yes) => live && setAgent(yes));
    return () => {
      live = false;
    };
  }, []);

  const current = KINDS.find((k) => k.kind === kind)!;
  const notReady =
    (kind === 'python' && !python.enabled) || (kind === 'agent' && !agent)
      ? ' This server has not reported Modal as configured — running it will say what is missing.'
      : '';

  return (
    <div className="res-settings">
      <section className="res-col">
        <h3 className="res-col__head">
          Node type
          <Info>{current.desc}</Info>
        </h3>
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
        {notReady && <p className="res-col__note res-col__note--warn">{notReady.trim()}</p>}
      </section>

      {kind !== 'test' && (
        <section className="res-col">
          <h3 className="res-col__head">
            Output
            <Info>
              The answer is parsed and validated (pbt&rsquo;s <code>output_format="json"</code>);
              one that is not JSON fails this bullet instead of flowing on as prose.
            </Info>
          </h3>
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
        </section>
      )}

      {kind === 'test' && (
        <section className="res-col">
          <h3 className="res-col__head">
            Judge
            <Info>
              {bullet.judge === 'llm'
                ? 'The run’s model reads the assertion and what is connected, and answers pass or fail.'
                : 'No LLM: the assertion is asked as a yes/no question about what is connected, and the classifier set in Settings answers with a probability.'}
            </Info>
          </h3>
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
        </section>
      )}

      {kind === 'python' && (
        <section className="res-col">
          <h3 className="res-col__head">
            Sandbox packages
            <Info>
              Comma-separated, installed before this bullet runs
              {python.packages.length
                ? ` on top of what the sandbox has: ${python.packages.join(', ')}.`
                : '.'}{' '}
              A script can also ask for its own with a PEP 723 header.
            </Info>
          </h3>
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
        </section>
      )}

      {kind === 'agent' && (
        <section className="res-col">
          <h3 className="res-col__head">
            MCP server
            <Info>
              The command that starts a stdio MCP server in the agent&rsquo;s sandbox, e.g.{' '}
              <code>uvx some-mcp-server</code> or <code>npx -y @scope/server</code>. Empty means
              none — the agent works with bash alone.
            </Info>
          </h3>
          <div className="res-col__body">
            <McpServerInput id={id} value={bullet.mcpServer} />
          </div>
        </section>
      )}

      {kind === 'agent' && (
        <section className="res-col">
          <h3 className="res-col__head">
            Files
            <Info>
              The agent is told to save the files it makes — images, documents, data — in{' '}
              <code>/root/outputs/</code>. They are handed to the prompt bullets this one feeds as
              attachments, and shown with its answer. An agent that saves none fails, since the
              bullets after it are waiting for them.
            </Info>
          </h3>
          <div className="res-col__body">
            <label className="ns-check">
              <input
                type="checkbox"
                checked={bullet.producesFiles}
                onChange={(e) => actions.setProducesFiles(id, e.target.checked)}
              />
              Produces files
            </label>
          </div>
        </section>
      )}

      {kind === 'agent' && (
        <section className="res-col">
          <h3 className="res-col__head">
            Max steps
            <Info>
              How many steps this agent may take — one per reply — before it is told to stop using
              tools and answer. Blank uses the run&rsquo;s default from Settings.
            </Info>
          </h3>
          <div className="res-col__body">
            <input
              className="pd-input"
              type="number"
              min={1}
              value={bullet.agentSteps || ''}
              placeholder="Default (Settings → agent steps)"
              onChange={(e) => actions.setAgentSteps(id, Number(e.target.value))}
            />
          </div>
        </section>
      )}

      {kind === 'agent' && (
        <section className="res-col">
          <h3 className="res-col__head">
            Back-off
            <Info>
              Seconds the agent waits after each model reply before its next call, to stay under a
              provider&rsquo;s rate limit. The wait counts against the sandbox&rsquo;s time limit
              (15 min), so keep it × steps well under that. Blank or 0 means no wait.
            </Info>
          </h3>
          <div className="res-col__body">
            <input
              className="pd-input"
              type="number"
              min={0}
              max={300}
              step={1}
              value={bullet.agentBackoff || ''}
              placeholder="0 — no wait (seconds)"
              onChange={(e) => actions.setAgentBackoff(id, Number(e.target.value))}
            />
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The MCP server command, with the known servers fuzzy-matched against what is
 * typed below it. ↑/↓ pick one, Enter or a click takes it; anything else typed
 * is kept as-is.
 */
function McpServerInput({ id, value }: { id: string; value: string }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const matches = open ? matchMcpServers(value).slice(0, 8) : [];
  const take = (command: string) => {
    actions.setMcpServer(id, command);
    setOpen(false);
  };

  return (
    <div className="mcp-pick">
      <input
        className="pd-input ns-mono"
        value={value}
        placeholder="uvx some-mcp-server — type to search known servers"
        spellCheck={false}
        autoComplete="off"
        autoFocus
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          actions.setMcpServer(id, e.target.value);
          setOpen(true);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (!matches.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setSel((i) => (i + step + matches.length) % matches.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            take(matches[Math.min(sel, matches.length - 1)].command);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setOpen(false);
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="mcp-pick__list">
          {matches.map((m, i) => (
            <li
              key={m.command}
              className={i === sel ? 'mcp-pick__item mcp-pick__item--sel' : 'mcp-pick__item'}
              onMouseDown={(e) => {
                e.preventDefault();
                take(m.command);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <code>{m.command}</code>
              <span>{m.desc}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
