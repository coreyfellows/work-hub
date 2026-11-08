/**
 * The Mercurial (hg) source-control provider (experimental: tested only against a fake `hg`). A working copy is a share
 * of the repo's own clone (`hg share`); its line is the active bookmark, else the branch. Removing one deletes the share's
 * folder (its commits live in the source repo's store); a folder that isn't a share is never removed.
 */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerPluginContext, SourceControlProvider, WorkingCopyState } from '../../plugin-api/server.ts';

type Run = ServerPluginContext['exec']['run'];

export interface HgProviderDeps {
  run: Run;
  /** The hg binary (default `hg` on PATH; tests point it at a fake). */
  bin?: string;
}

const TIMEOUT_MS = 20_000;

/** owner/name from a remote URL (same rule as the core's git `parseRepo`). */
export function parseRepo(url: string): string | null {
  const m = url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git|\.hg)?\/?$/);
  return m ? m[1] : null;
}

/** `s` single-quoted for a POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The folder/bookmark name for a ticket key: the key itself only when it looks like one (it reaches prompt text). */
export const ticketName = (key: string | null) => (key && /^[A-Z][A-Z0-9]+-\d+$/.test(key) ? key : null);

const exists = (p: string, dir: boolean) => stat(p).then((s) => (dir ? s.isDirectory() : s.isFile()), () => false);

export function createHgProvider({ run, bin = 'hg' }: HgProviderDeps): SourceControlProvider {
  const hg = (args: string[], cwd?: string) => run(bin, args, { timeoutMs: TIMEOUT_MS, cwd });
  const trimmed = (args: string[]) => hg(args).then((s) => s.trim() || null, () => null);

  /** Facts removal depends on; `hard` can't be waived with force. */
  async function facts(root: string): Promise<{ exists: boolean; dirty: boolean; hard: string | null }> {
    if (!(await exists(root, true))) return { exists: false, dirty: false, hard: null };
    // A share has `.hg/sharedpath` (the source's store); without it the folder is a repo's own clone.
    if (!(await exists(join(root, '.hg', 'sharedpath'), false))) return { exists: true, dirty: false, hard: "not an hg share (a repo's own clone is never removed)" };
    const status = await hg(['-R', root, 'status']);
    return { exists: true, dirty: status.trim() !== '', hard: null };
  }

  const blockOf = (f: { dirty: boolean; hard: string | null }, force: boolean) => f.hard ?? (!force && f.dirty ? 'uncommitted changes' : null);

  return {
    id: 'hg',
    title: 'Mercurial (hg)',
    experimental: true,
    detect: (path) => hg(['root'], path).then((s) => s.trim() || null, () => null),
    identity: async (root) => {
      const url = await trimmed(['-R', root, 'paths', 'default']);
      return { repo: url ? parseRepo(url) : null };
    },
    line: async (root) => {
      const [bookmark, head] = await Promise.all([
        trimmed(['-R', root, 'log', '-r', '.', '-T', '{activebookmark}']),
        trimmed(['-R', root, 'log', '-r', '.', '-T', '{node|short}']),
      ]);
      return { line: bookmark ?? (await trimmed(['-R', root, 'branch'])), head };
    },
    sharedLines: new Set(['default']),
    inspect: async (root): Promise<WorkingCopyState> => {
      const f = await facts(root);
      const block = blockOf(f, false);
      return { exists: f.exists, dirty: f.dirty, unsaved: 0, removable: block === null, block };
    },
    removeWorkingCopy: async (root, { force }) => {
      const f = await facts(root);
      if (!f.exists) return; // nothing on disk: only the record goes
      const block = blockOf(f, force);
      if (block) throw new Error(`can't remove ${root}: ${block}`);
      await rm(root, { recursive: true, force: true });
    },
    agentInstructions: (o) => {
      const ticket = ticketName(o.ticketKey);
      const name = ticket ?? '<short-kebab-desc>';
      const path = shq(`${o.worktreesDir}/<repo>/${name}`);
      return [
        `Working copies are Mercurial (hg) shares (experimental): one per repo at \`${path}\`${ticket ? '' : ' (<short-kebab-desc>: a short kebab-case name for the task)'}, shared with its bookmarks from the repo's own clone <source>.`,
        `\`hg share -B <source> ${path}\`, then \`hg -R ${path} update <base>\` (<base>: \`default\` unless the work builds on another branch or bookmark)`,
        `\`hg -R ${path} bookmark ${name}\`, then \`${o.whCommand} trust ${path}\``,
        `\`${o.whCommand} worktree add ${o.workspaceId} --path ${path} --vcs hg --branch ${name} --base <base>\``,
      ];
    },
    prereq: () =>
      hg(['--version']).then(
        (s) => ({ ok: true, detail: s.trim().split('\n')[0] }),
        (e: unknown) => ({ ok: false, detail: `hg not found: ${e instanceof Error ? e.message : String(e)}` }),
      ),
  };
}
