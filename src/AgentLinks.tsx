/**
 * Links an agent hands over — its live browser, its Agent37 desktop, a public
 * port, the public URL it says its app is at — pulled out of its log and its
 * answer and shown as bars of their own, so they are not lost in the text.
 */

/** Log lines carrying a link, and what to call each. */
const LOG_LINKS: [RegExp, string][] = [
  [/^browser: watch live at (https?:\/\/\S+)/, 'Watch the browser'],
  [/^desktop: watch the agent's screen: (https?:\/\/\S+)/, 'Watch the desktop'],
  [/^public: port (\d+) is public at (https?:\/\/\S+)/, 'Public port'],
];

/**
 * The block an agent with a public URL is asked to end its answer with — see
 * `PUBLIC_URL_INSTRUCTION` in `server/main.py`. The answer may arrive as JSON,
 * whose newlines are the two characters `\n`, so those count as space too.
 */
const PUBLIC_BLOCK = /\[public url\](?:\s|\\n)*(https?:\/\/[^\s\\"'<>\]]+)(?:\s|\\n)*\[\/public url\]/i;

export interface AgentLink {
  label: string;
  url: string;
}

/** The links in an agent's log lines and its answer, each once, log first. */
export function agentLinks(lines: string[] = [], output?: string): AgentLink[] {
  const out: AgentLink[] = [];
  const add = (label: string, url: string) => {
    const same = out.find((l) => l.url === url);
    if (!same) out.push({ label, url });
    // The agent saying the app is up there is the better name for the link.
    else if (label === 'Open the app') same.label = label;
  };
  for (const raw of lines) {
    const line = raw.replace(/^\[\s*[\d.]+s\]\s*/, '');
    for (const [re, label] of LOG_LINKS) {
      const m = line.match(re);
      if (m) add(m.length > 2 ? `${label} ${m[1]}` : label, m[m.length - 1]);
    }
  }
  const m = output?.match(PUBLIC_BLOCK);
  if (m) add('Open the app', m[1]);
  return out;
}

/** The links as bars, one each. Nothing when there are none. */
export function AgentLinks({ links, className = '' }: { links: AgentLink[]; className?: string }) {
  if (!links.length) return null;
  return (
    <div className={`rp__pins ${className}`}>
      {links.map((p) => (
        <a key={p.url} className="rp__pin" href={p.url} target="_blank" rel="noreferrer" title={p.url}>
          {p.label} ↗
        </a>
      ))}
    </div>
  );
}
