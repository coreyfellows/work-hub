import type { ServerPluginContext, Source } from '../../plugin-api/server.ts';
import type { HealthCheck, HealthData, McpServer } from './types.ts';

/**
 * Local connection health, checked without spending tokens: Claude login, GitHub CLI login and MCP servers
 * (via `claude mcp list`, which connects to each).
 */

export type { HealthCheck, HealthData, McpServer } from './types.ts';

export interface HealthOptions {
  intervalMs: number;
  /** MCP servers whose failure turns the dot red (others are just listed). */
  watchedMcp: string[];
  /** The GitHub host `gh auth status` is checked against, or how to find it on each check (`githubHostResolver`). */
  githubHost: string | (() => Promise<string>);
  /** cwd for `claude mcp list`: somewhere neutral, so no project's .mcp.json is picked up. */
  scratchDir: string;
  exec: ServerPluginContext['exec'];
}

async function claudeLogin(o: HealthOptions): Promise<HealthCheck> {
  const base = { id: 'claude-auth', label: 'Claude login', level: 'fire' as const };
  try {
    const s = await o.exec.runJson<{ loggedIn?: boolean; authMethod?: string }>('claude', ['auth', 'status', '--json'], { timeoutMs: 15_000 });
    return { ...base, ok: !!s.loggedIn, detail: s.loggedIn ? `signed in (${s.authMethod ?? 'ok'})` : 'not signed in: run `claude auth login`' };
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message };
  }
}

/** The fallback when no host is configured and the github plugin is off. */
export const DEFAULT_GITHUB_HOST = 'github.com';

/**
 * The host for the sign-in check: a configured one as is; otherwise the github plugin's own resolved host (its setting,
 * else the gh config's host), asked on each check because that plugin may load after this one or be switched off;
 * `github.com` while it's off or can't say.
 */
export function githubHostResolver(configured: string | undefined, github: () => { host(): Promise<string> } | undefined): string | (() => Promise<string>) {
  if (configured) return configured;
  return async () => {
    try {
      return (await github()?.host()) || DEFAULT_GITHUB_HOST;
    } catch {
      return DEFAULT_GITHUB_HOST;
    }
  };
}

async function githubLogin(o: HealthOptions): Promise<HealthCheck> {
  const host = typeof o.githubHost === 'string' ? o.githubHost : await o.githubHost();
  const base = { id: 'gh-auth', label: `GitHub CLI (${host})`, level: 'fire' as const };
  try {
    await o.exec.run('gh', ['auth', 'status', '--hostname', host], { timeoutMs: 15_000 });
    return { ...base, ok: true, detail: 'signed in' };
  } catch (err) {
    return { ...base, ok: false, detail: `${(err as Error).message.split('\n').pop()}: run \`gh auth login --hostname ${host}\`` };
  }
}

/** Parse `claude mcp list`: "name: <command or url> - ✔ Connected" / "! Needs authentication" / "✘ Failed to connect — why". */
export function parseMcpList(out: string, watched: string[]): McpServer[] {
  const servers: McpServer[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+?):\s.*\s-\s([✔!✘])\s*(.*)$/u);
    if (!m) continue;
    const [, name, mark, rest] = m;
    // "!" is a warning, not necessarily auth: "! Connected · tools fetch failed — Request timed out" is
    // a slow moment; only "Needs authentication" means signing in again.
    const text = rest.trim();
    const state = mark === '✘' ? 'failed' : /needs auth/i.test(text) ? 'needs-auth' : /^connected/i.test(text) || mark === '✔' ? 'connected' : 'unknown';
    servers.push({ name, state, detail: mark === '✔' ? '' : text, watched: watched.includes(name) });
  }
  return servers;
}

async function mcpServers(o: HealthOptions): Promise<McpServer[]> {
  const out = await o.exec.run('claude', ['mcp', 'list'], { cwd: o.scratchDir, timeoutMs: 60_000 });
  return parseMcpList(out, o.watchedMcp);
}

export function healthSource(o: HealthOptions): Source<HealthData> {
  return {
    id: 'health',
    title: 'Connections',
    intervalMs: o.intervalMs,
    fetch: async () => {
      const [checks, mcp] = await Promise.all([
        Promise.all([claudeLogin(o), githubLogin(o)]),
        mcpServers(o).catch((err) => [{ name: 'claude mcp list', state: 'unknown' as const, detail: (err as Error).message, watched: true }]),
      ]);
      return { checks, mcp };
    },
  };
}
