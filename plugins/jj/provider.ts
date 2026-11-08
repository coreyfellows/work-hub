/**
 * The Jujutsu (jj) source-control provider (experimental: tested only against a fake `jj`). A working copy is a jj
 * workspace made with `jj workspace add` beside the repo's own checkout; its line is the bookmark at `@`, else the
 * change id. Removing one forgets the workspace in the repo and deletes its folder; the repo's own workspace (the one
 * holding `.jj/repo`) is never removed.
 */
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerPluginContext, SourceControlProvider, WorkingCopyState } from '../../plugin-api/server.ts';

type Run = ServerPluginContext['exec']['run'];

export interface JjProviderDeps {
  run: Run;
  /** The jj binary (default `jj` on PATH; tests point it at a fake). */
  bin?: string;
}

const TIMEOUT_MS = 20_000;

/** owner/name from a remote URL (same rule as the core's git `parseRepo`). */
export function parseRepo(url: string): string | null {
  const m = url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/** The first bookmark in `jj log -T local_bookmarks` output, without jj's markers (`*` ahead/behind, `??` conflicted). */
export function firstBookmark(out: string): string | null {
  const name = out.trim().split(/\s+/)[0]?.replace(/[*?]+$/, '') ?? '';
  return name || null;
}

/** `s` single-quoted for a POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The folder/bookmark name for a ticket key: the key itself only when it looks like one (it reaches prompt text). */
export const ticketName = (key: string | null) => (key && /^[A-Z][A-Z0-9]+-\d+$/.test(key) ? key : null);

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

export function createJjProvider({ run, bin = 'jj' }: JjProviderDeps): SourceControlProvider {
  const jj = (args: string[], cwd?: string) => run(bin, args, { timeoutMs: TIMEOUT_MS, cwd });

  /** Facts removal depends on; `hard` can't be waived with force. */
  async function facts(root: string): Promise<{ exists: boolean; dirty: boolean; hard: string | null }> {
    if (!(await isDir(root))) return { exists: false, dirty: false, hard: null };
    // The repo's own workspace has the store in `.jj/repo` (a directory); a secondary workspace has a file pointing to it.
    if (await isDir(join(root, '.jj', 'repo'))) return { exists: true, dirty: false, hard: "the repo's own jj workspace (it holds the store) is never removed" };
    const diff = await jj(['-R', root, 'diff', '--summary']);
    return { exists: true, dirty: diff.trim() !== '', hard: null };
  }

  const blockOf = (f: { dirty: boolean; hard: string | null }, force: boolean) => f.hard ?? (!force && f.dirty ? 'changes in its working-copy commit' : null);

  return {
    id: 'jj',
    title: 'Jujutsu (jj)',
    experimental: true,
    detect: (path) => jj(['root'], path).then((s) => s.trim() || null, () => null),
    identity: async (root) => {
      const out = await jj(['-R', root, '--ignore-working-copy', 'git', 'remote', 'list']).catch(() => '');
      const origin = out.split('\n').find((l) => l.startsWith('origin '));
      return { repo: origin ? parseRepo(origin.slice('origin '.length)) : null };
    },
    line: async (root) => {
      // The nearest local bookmark on @'s ancestry, so the line survives `jj commit` / `jj new` moving @ past it.
      const [bookmarks, change] = await Promise.all([
        jj(['-R', root, '--ignore-working-copy', 'log', '-r', 'latest(::@ & bookmarks())', '--no-graph', '-T', 'local_bookmarks']).catch(() => ''),
        jj(['-R', root, '--ignore-working-copy', 'log', '-r', '@', '--no-graph', '-T', 'change_id.short()']).then((s) => s.trim() || null, () => null),
      ]);
      return { line: firstBookmark(bookmarks) ?? change, head: change };
    },
    sharedLines: new Set(['main', 'master', 'trunk']),
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
      // With no name, `workspace forget` forgets the workspace `-R` points at (its name isn't kept anywhere we can read).
      await jj(['-R', root, 'workspace', 'forget']);
      await rm(root, { recursive: true, force: true });
    },
    agentInstructions: (o) => {
      const ticket = ticketName(o.ticketKey);
      const name = ticket ?? '<short-kebab-desc>';
      const path = shq(`${o.worktreesDir}/<repo>/${name}`);
      return [
        `Working copies are Jujutsu (jj) workspaces (experimental): one per repo at \`${path}\`${ticket ? '' : ' (<short-kebab-desc>: a short kebab-case name for the task)'}, made from the repo's own checkout <source>.`,
        `\`jj -R <source> workspace add ${path} --name ${o.workspaceId} -r '<base>'\` (<base>: \`trunk()\` unless the work builds on another revision)`,
        `\`jj -R ${path} bookmark create ${name} -r @\`, then \`${o.whCommand} trust ${path}\``,
        `\`${o.whCommand} worktree add ${o.workspaceId} --path ${path} --vcs jj --branch ${name} --base '<base>'\``,
      ];
    },
    prereq: () =>
      jj(['--version']).then(
        (s) => ({ ok: true, detail: s.trim() }),
        (e: unknown) => ({ ok: false, detail: `jj not found: ${e instanceof Error ? e.message : String(e)}` }),
      ),
  };
}
