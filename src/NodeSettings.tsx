import { useEffect, useState, type ReactNode } from 'react';
import { Info } from './Info';
import { agentEnabled, pythonInfo } from './api';
import { useAgent37Key } from './lib/agent37Key';
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
 *
 * The kind picker spans the top; below it every setting is one label/control
 * row in a single column, so changing a setting only ever moves the rows
 * beneath it — never the control you just clicked.
 */
export function NodeSettings({ bullet }: Props) {
  // Blank means preserve-disk runs land on the shared machine — warned below.
  const agent37Key = useAgent37Key();
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
    (kind === 'python' && !python.enabled) || (kind === 'agent' && !agent && !bullet.persistDisk)
      ? 'This server has not reported Modal as configured — running it will say what is missing.'
      : '';

  return (
    <div className="res-settings">
      <div className="ns-type">
        <div className="ns-seg" role="radiogroup" aria-label="Node type">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              role="radio"
              aria-checked={kind === k.kind}
              className={`ns-seg__opt ${kind === k.kind ? 'ns-seg__opt--on' : ''}`}
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
        <p className="ns-type__desc">{current.desc}</p>
        {notReady && <p className="ns-warn">{notReady}</p>}
      </div>

      <div className="ns-rows">
        {kind !== 'test' && (
          <Row
            label="Output"
            info={
              <>
                The answer is parsed and validated (pbt&rsquo;s <code>output_format="json"</code>);
                one that is not JSON fails this bullet instead of flowing on as prose.
              </>
            }
          >
            <label className="ns-check">
              <input
                type="checkbox"
                checked={bullet.jsonOutput}
                onChange={(e) => actions.setJsonOutput(id, e.target.checked)}
              />
              Enforce JSON output
            </label>
          </Row>
        )}

        {kind === 'test' && (
          <Row
            label="Judge"
            info={
              bullet.judge === 'llm'
                ? 'The run’s model reads the assertion and what is connected, and answers pass or fail.'
                : 'No LLM: the assertion is asked as a yes/no question about what is connected, and the classifier set in Settings answers with a probability.'
            }
          >
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
          </Row>
        )}

        {kind === 'test' && bullet.judge === 'classifier' && (
          <Row label="Pass when P(yes) ≥">
            <input
              className="pd-input ns-num"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={bullet.threshold}
              onChange={(e) => actions.setThreshold(id, e.target.valueAsNumber)}
            />
          </Row>
        )}

        {kind === 'python' && (
          <Row
            label="Sandbox packages"
            info={
              <>
                Comma-separated, installed before this bullet runs
                {python.packages.length
                  ? ` on top of what the sandbox has: ${python.packages.join(', ')}.`
                  : '.'}{' '}
                A script can also ask for its own with a PEP 723 header.
              </>
            }
          >
            <input
              className="pd-input"
              value={bullet.packages}
              placeholder="beautifulsoup4, lxml, scipy==1.*"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => actions.setPackages(id, e.target.value)}
            />
          </Row>
        )}

        {kind === 'agent' && (
          <Row
            label="Runs on"
            info={
              <>
                <b>Sandbox</b> — a fresh Modal machine every run, gone when it ends. MCP server and
                back-off are set here.
                <br />
                <b>Agent37 — persistent</b> — an Agent37 machine kept between runs, in this
                bullet&rsquo;s own session and folder: it remembers its earlier conversation, and
                what it leaves in its folder is there next time. The machine sleeps (disk-only
                billing) when idle and wakes on the next run. It can also get a public URL.
              </>
            }
            warn={
              bullet.persistDisk && !agent37Key.trim()
                ? 'Not private: this runs on a machine shared with everyone on this server, and their agents could read this one’s files. Add your own Agent37 key in Settings for a machine of your own.'
                : ''
            }
          >
            <div className="ns-kinds" role="radiogroup" aria-label="Runs on">
              {[
                { on: false, label: 'Sandbox' },
                { on: true, label: 'Agent37 — persistent' },
              ].map((r) => (
                <button
                  key={r.label}
                  role="radio"
                  aria-checked={bullet.persistDisk === r.on}
                  className={`ns-kind ${bullet.persistDisk === r.on ? 'ns-kind--on' : ''}`}
                  onClick={() => actions.setPersistDisk(id, r.on)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </Row>
        )}

        {kind === 'agent' && bullet.persistDisk && (
          <Row
            label="Public URL"
            info="Gives this bullet a port of its own on the Agent37 machine and a permanent public HTTPS link to it. The agent is told the port and the link, so a site, API or webhook it serves there is reachable by anyone who has the link — no sign-in. The link shows up in the live log and stays the same across runs."
          >
            <label className="ns-check">
              <input
                type="checkbox"
                checked={bullet.publicUrl}
                onChange={(e) => actions.setPublicUrl(id, e.target.checked)}
              />
              Create public URL
            </label>
          </Row>
        )}

        {kind === 'agent' && (
          <Row
            label="Files"
            info={
              <>
                The agent is told to save the files it makes — images, documents, data — in{' '}
                <code>{bullet.persistDisk ? 'outputs/' : '/root/outputs/'}</code>
                {bullet.persistDisk &&
                  ' in its own folder, emptied at the start of each run (the rest of the folder is kept)'}
                . They are handed to the prompt bullets this one feeds as attachments, and shown
                with its answer. An agent that saves none fails, since the bullets after it are
                waiting for them.
              </>
            }
          >
            <label className="ns-check">
              <input
                type="checkbox"
                checked={bullet.producesFiles}
                onChange={(e) => actions.setProducesFiles(id, e.target.checked)}
              />
              Produces files
            </label>
          </Row>
        )}

        {kind === 'agent' && (
          <Row
            label="Browser"
            info={
              bullet.persistDisk ? (
                <>
                  Links the Agent37 machine&rsquo;s desktop in the agent&rsquo;s live log, so you
                  can watch the browser it drives and take over — to sign in, say. The link lasts a
                  few minutes; each run makes a new one.
                </>
              ) : (
                <>
                  Opens a Chromium in the agent&rsquo;s sandbox that you can watch and take over
                  from your own browser — the link shows up in the agent&rsquo;s live log. The
                  agent drives it over the DevTools protocol at <code>http://localhost:9222</code>;
                  pair it with the MCP server{' '}
                  <code>npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222</code> to
                  give it browser tools. It closes when the agent finishes.
                </>
              )
            }
          >
            <label className="ns-check">
              <input
                type="checkbox"
                checked={bullet.remoteBrowser}
                onChange={(e) => actions.setRemoteBrowser(id, e.target.checked)}
              />
              Create browser
            </label>
          </Row>
        )}

        {kind === 'agent' && (
          <Row
            label="Max steps"
            info="How many steps this agent may take — one per reply — before it is told to stop using tools and answer. Blank uses the run’s default from Settings."
          >
            <input
              className="pd-input"
              type="number"
              min={1}
              value={bullet.agentSteps || ''}
              placeholder="Default (Settings → agent steps)"
              onChange={(e) => actions.setAgentSteps(id, Number(e.target.value))}
            />
          </Row>
        )}

        {kind === 'agent' && !bullet.persistDisk && (
          <Row
            label="MCP server"
            info={
              <>
                The command that starts a stdio MCP server in the agent&rsquo;s sandbox, e.g.{' '}
                <code>uvx some-mcp-server</code> or <code>npx -y @scope/server</code>. Empty means
                none — the agent works with bash alone.
              </>
            }
          >
            <McpServerInput id={id} value={bullet.mcpServer} />
          </Row>
        )}

        {kind === 'agent' && !bullet.persistDisk && (
          <Row
            label="Back-off"
            info="Seconds the agent waits after each model reply before its next call, to stay under a provider’s rate limit. The wait counts against the sandbox’s time limit (15 min), so keep it × steps well under that. Blank or 0 means no wait."
          >
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
          </Row>
        )}
      </div>
    </div>
  );
}

/**
 * One setting: its label (with the why behind an "i") on the left, the control
 * on the right — stacked on a phone. A warning spans the full row beneath it.
 */
function Row({
  label,
  info,
  warn,
  children,
}: {
  label: string;
  info?: ReactNode;
  warn?: string;
  children: ReactNode;
}) {
  return (
    <div className="ns-row">
      <div className="ns-row__label">
        {label}
        {info && <Info>{info}</Info>}
      </div>
      <div className="ns-row__control">{children}</div>
      {warn && <p className="ns-warn ns-row__warn">{warn}</p>}
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
