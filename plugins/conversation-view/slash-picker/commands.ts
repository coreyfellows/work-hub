import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { SlashCommand } from './shared/types.ts';

/**
 * The slash commands a Claude session offers: its skills and commands (user, project, enabled plugins) plus a few
 * built-ins. Read from disk, so a picker in the prompt box can list them without asking Claude.
 */

export type { SlashCommand } from './shared/types.ts';

/** Built-in commands and what they do. Claude's headless init lists most of these but not the interactive-only ones, so all are kept. */
const BUILT_IN: Array<[string, string]> = [
  ['add-dir', 'Add a working directory to this session'],
  ['agents', 'Manage subagents'],
  ['clear', 'Clear the conversation and start fresh'],
  ['color', 'Set the prompt bar color for this session'],
  ['compact', 'Summarize the conversation to free up context'],
  ['config', 'Open the settings'],
  ['context', 'Show what is using the context window'],
  ['copy', 'Copy the last response to the clipboard'],
  ['cost', 'Show token usage and cost for this session'],
  ['diff', 'View uncommitted changes and per-turn diffs'],
  ['doctor', 'Check the health of your Claude Code install'],
  ['effort', 'Set how much effort the model puts in'],
  ['exit', 'Exit Claude Code'],
  ['export', 'Export the conversation to a file or the clipboard'],
  ['fast', 'Toggle fast mode'],
  ['focus', 'Toggle the focus view'],
  ['help', 'Show help and the available commands'],
  ['hooks', 'View hook configurations'],
  ['ide', 'Manage IDE integrations'],
  ['init', 'Create a CLAUDE.md for this project'],
  ['install-github-app', 'Set up the Claude GitHub Actions app'],
  ['login', 'Sign in'],
  ['logout', 'Sign out'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit Claude memory files'],
  ['model', 'Switch the model'],
  ['output-style', 'Set the output style'],
  ['permissions', 'View and edit tool permissions'],
  ['plugin', 'Manage plugins'],
  ['pr-comments', 'Get comments from a pull request'],
  ['release-notes', 'View the release notes'],
  ['reload-plugins', 'Reload plugins without restarting'],
  ['rename', 'Rename this session'],
  ['resume', 'Resume an earlier conversation'],
  ['review', 'Review a pull request'],
  ['rewind', 'Rewind the conversation and code to an earlier point'],
  ['security-review', 'Review pending changes for security issues'],
  ['status', 'Show version, model and account status'],
  ['statusline', 'Set up the status line'],
  ['terminal-setup', 'Install the terminal key bindings'],
  ['theme', 'Change the color theme'],
  ['todos', 'List the current todo items'],
  ['usage', 'Show plan usage and limits'],
  ['vim', 'Toggle vim editing mode'],
];

/** `name`, `description` and `user-invocable` from a Markdown file's YAML front matter (flat keys, quoted or block scalars). */
export function parseFrontmatter(text: string): { name?: string; description?: string; invocable: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: { name?: string; description?: string; invocable: boolean } = { invocable: true };
  if (!m) return out;
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      v = parts.join(' ');
    } else if (!v) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !/^\s+[\w-]+:/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      v = parts.join(' ');
    }
    v = v.replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (kv[1] === 'name') out.name = v;
    else if (kv[1] === 'description') out.description = v;
    else if (kv[1] === 'user-invocable' && v === 'false') out.invocable = false;
  }
  return out;
}

/** Descriptions for Claude's bundled skills, which have no files on disk to read one from. */
const BUNDLED: Record<string, string> = {
  batch: 'Run a large change in parallel across many agents',
  debug: 'Debug a problem in this session or the current code',
  'code-review': 'Review the current diff or a PR for bugs',
  simplify: 'Review changed code for reuse and simplification, then fix',
  loop: 'Run a prompt or command on a recurring interval',
  verify: 'Verify that a change works',
  'claude-api': 'Help building with the Claude API and SDKs',
  'update-config': 'Change Claude Code settings, hooks and permissions',
  'fewer-permission-prompts': 'Add an allowlist to cut down permission prompts',
  goal: 'Set a goal for Claude to keep working toward',
  insights: 'Report on how you use Claude Code',
  recap: 'Recap what happened in this session',
  heapdump: 'Write a heap dump for debugging memory use',
  autocompact: 'Set when the conversation compacts itself',
  'deep-research': 'Research a question in depth',
  design: 'Design work with Claude',
  run: 'Launch the project and see a change working',
  'list-agents': 'List running agents',
  'team-onboarding': 'Help a teammate get started with Claude Code',
};

const short = (s: string) => (s.length > 200 ? `${s.slice(0, 197)}…` : s);

async function skillsIn(dir: string, prefix: string, source: SlashCommand['source'], plugin?: string): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const text = await readFile(join(dir, e.name, 'SKILL.md'), 'utf8').catch(() => null);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    if (!fm.invocable) continue;
    out.push({ name: prefix + (fm.name || e.name), description: short(fm.description ?? ''), source, plugin });
  }
  return out;
}

async function commandsIn(dir: string, prefix: string, source: SlashCommand['source'], plugin?: string): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) {
        const text = await readFile(p, 'utf8').catch(() => '');
        const fm = parseFrontmatter(text);
        const name = relative(dir, p).slice(0, -3).split(sep).join(':');
        const body = text.replace(/^---[\s\S]*?---\s*/, '').split('\n').find((l) => l.trim()) ?? '';
        out.push({ name: prefix + name, description: short(fm.description ?? body.replace(/^#+\s*/, '')), source, plugin });
      }
    }
  };
  await walk(dir);
  return out;
}

async function readJson<T>(path: string): Promise<T | null> {
  return readFile(path, 'utf8').then((t) => JSON.parse(t) as T, () => null);
}

/** Every command available to a session working in `cwd`, sorted by name; the first of two with a name wins (project beats user beats plugin). */
export async function slashCommands(cwd: string, home = homedir(), probed: string[] = []): Promise<SlashCommand[]> {
  const claude = join(home, '.claude');
  const lists: SlashCommand[][] = [];
  lists.push(await skillsIn(join(cwd, '.claude', 'skills'), '', 'project'), await commandsIn(join(cwd, '.claude', 'commands'), '', 'project'));
  lists.push(await skillsIn(join(claude, 'skills'), '', 'user'), await commandsIn(join(claude, 'commands'), '', 'user'));

  const enabled = {
    ...((await readJson<{ enabledPlugins?: Record<string, boolean> }>(join(claude, 'settings.json')))?.enabledPlugins ?? {}),
    ...((await readJson<{ enabledPlugins?: Record<string, boolean> }>(join(cwd, '.claude', 'settings.json')))?.enabledPlugins ?? {}),
  };
  const installed = (await readJson<{ plugins?: Record<string, Array<{ scope?: string; installPath: string; projectPath?: string }>> }>(join(claude, 'plugins', 'installed_plugins.json')))?.plugins ?? {};
  for (const [key, installs] of Object.entries(installed)) {
    if (enabled[key] !== true) continue;
    const at = installs.find((i) => i.scope === 'user') ?? installs.find((i) => i.projectPath && cwd.startsWith(i.projectPath)) ?? null;
    if (!at) continue;
    const manifest = await readJson<{ name?: string }>(join(at.installPath, '.claude-plugin', 'plugin.json'));
    const plugin = manifest?.name || key.split('@')[0]!;
    lists.push(await skillsIn(join(at.installPath, 'skills'), `${plugin}:`, 'plugin', plugin), await commandsIn(join(at.installPath, 'commands'), `${plugin}:`, 'plugin', plugin));
  }
  lists.push(BUILT_IN.map(([name, description]) => ({ name, description, source: 'built-in' as const })));
  // Whatever Claude itself reports for this directory but the disk scan didn't find (other built-ins, MCP prompts).
  lists.push(
    probed
      .filter((n) => !n.startsWith('__'))
      .map((name) => ({ name, description: name.startsWith('mcp__') ? 'MCP prompt' : '', source: (name.includes(':') ? 'plugin' : 'built-in') as SlashCommand['source'], plugin: name.includes(':') ? name.split(':')[0] : undefined })),
  );

  const seen = new Set<string>();
  const all: SlashCommand[] = [];
  for (const c of lists.flat()) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    all.push(c.description ? c : { ...c, description: BUNDLED[c.name] ?? '' });
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The command names Claude reports for a directory: the init event of a headless run (it arrives about 3s in, before
 * any model call, so the run is killed right after). Same set the terminal offers, MCP prompts included. [] on failure.
 */
export function probeCommandNames(cwd: string, timeoutMs = 20_000): Promise<string[]> {
  return new Promise((done) => {
    const child = spawn('claude', ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let finished = false;
    const finish = (names: string[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      done(names);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on('error', () => finish([]));
    child.on('close', () => finish([]));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const j = JSON.parse(line) as { type?: string; subtype?: string; slash_commands?: string[]; terminal_slash_commands?: string[] };
          if (j.type === 'system' && j.subtype === 'init') return finish([...new Set([...(j.slash_commands ?? []), ...(j.terminal_slash_commands ?? [])])]);
        } catch {
          /* not JSON */
        }
      }
    });
  });
}
