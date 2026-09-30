/** MCP servers offered as suggestions in an agent's MCP server field. */
export const KNOWN_MCP_SERVERS: { command: string; desc: string }[] = [
  { command: 'uvx --python 3.12 build123d-mcp@latest', desc: 'build123d CAD' },
  { command: 'npx -y @playwright/mcp@latest', desc: 'Playwright browser' },
  { command: 'uvx mcp-server-fetch', desc: 'fetch web pages' },
  { command: 'uvx mcp-server-git', desc: 'git repositories' },
  { command: 'uvx mcp-server-time', desc: 'time and time zones' },
  { command: 'npx -y @modelcontextprotocol/server-filesystem /root', desc: 'filesystem' },
  { command: 'npx -y @modelcontextprotocol/server-memory', desc: 'knowledge-graph memory' },
  { command: 'npx -y @modelcontextprotocol/server-sequential-thinking', desc: 'sequential thinking' },
  { command: 'npx -y @modelcontextprotocol/server-everything', desc: 'test server, every feature' },
];

/**
 * How well `query` fuzzy-matches `text`: its characters, in order, anywhere in
 * `text`. Higher is better; null is no match. Consecutive runs and matches at
 * word starts score more, and an exact substring most, so `b123` finds
 * build123d ahead of scattered hits.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let run = 0;
  let ti = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    run = at === ti ? run + 1 : 1;
    score += run * 2 + (at === 0 || /[\s/@\-_.]/.test(t[at - 1]) ? 3 : 0) - Math.min(at - ti, 5) * 0.2;
    ti = at + 1;
  }
  return t.includes(q) ? score + q.length * 4 : score;
}

/** The known servers matching `query`, best first. */
export function matchMcpServers(query: string) {
  return KNOWN_MCP_SERVERS.map((s) => ({ ...s, score: fuzzyScore(query, `${s.command} ${s.desc}`) }))
    .filter((s): s is typeof s & { score: number } => s.score !== null && s.command !== query.trim())
    .sort((a, b) => b.score - a.score);
}
