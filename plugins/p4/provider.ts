/**
 * The Perforce (p4) source-control provider (experimental: tested only against a fake `p4`). A working copy is a client
 * workspace copied from a template client (the `templates` setting) with its Root set to the new folder; its line is the
 * client's stream. Removing one refuses while files are opened or changelists shelved (unless forced), then deletes the
 * client (`p4 client -d`) and its folder. Uses the user's own p4 login and settings (P4PORT, P4USER, tickets, P4CONFIG);
 * stores no credentials.
 */
import { rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ServerPluginContext, SourceControlProvider, WorkingCopyState } from '../../plugin-api/server.ts';

type Run = ServerPluginContext['exec']['run'];

/** A client to copy new working copies from (plugins.json `settings.p4.templates`). */
export interface P4Template {
  name: string;
  client: string;
}

export interface P4ProviderDeps {
  run: Run;
  /** The p4 binary (default `p4` on PATH; tests point it at a fake). */
  bin?: string;
  templates?: P4Template[];
  /** The P4CONFIG file name the provider runs p4 with and the instructions write (default: `$P4CONFIG`, else `.p4config`). */
  p4config?: string;
}

const TIMEOUT_MS = 30_000;

/** The `templates` setting, keeping only well-formed `{ name, client }` entries (anything else is ignored). */
export function parseTemplates(raw: unknown): P4Template[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) =>
    t && typeof t === 'object' && typeof t.name === 'string' && typeof t.client === 'string' && t.name.trim() && t.client.trim()
      ? [{ name: t.name.trim(), client: t.client.trim() }]
      : [],
  );
}

/** `s` single-quoted for a POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The folder name for a ticket key: the key itself only when it looks like one (it reaches prompt text). */
export const ticketName = (key: string | null) => (key && /^[A-Z][A-Z0-9]+-\d+$/.test(key) ? key : null);

/** Clients work-hub's instructions create: `<user>-wh-<workspace>[-<template>]`. Only these are ever deleted. */
const WH_CLIENT = /-wh-[^ ]+$/;

const isInside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Lines of `p4 opened` output naming a file (messages such as "File(s) not opened" aren't counted). */
const countOpened = (out: string) => out.split('\n').filter((l) => l.startsWith('//')).length;
/** Lines of `p4 changes` output naming a changelist. */
const countChanges = (out: string) => out.split('\n').filter((l) => /^Change \d+/.test(l)).length;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function createP4Provider({ run, bin = 'p4', templates = [], p4config = process.env.P4CONFIG || '.p4config' }: P4ProviderDeps): SourceControlProvider {
  // The copies the instructions make name their client in this file; the provider runs p4 with it as P4CONFIG.
  const env = { P4CONFIG: p4config };
  const p4 = (args: string[], cwd?: string) => run(bin, args, { timeoutMs: TIMEOUT_MS, cwd, env });
  const trimmed = (args: string[]) => p4(args).then((s) => s.trim() || null, () => null);

  /** The user's client whose Root is `root` (`p4 clients --me`), or null. */
  async function clientFor(root: string): Promise<string | null> {
    const out = await p4(['-F', '%client% %Root%', 'clients', '--me']);
    for (const l of out.split('\n')) {
      const sp = l.indexOf(' ');
      if (sp > 0 && resolve(l.slice(sp + 1).trim()) === resolve(root)) return l.slice(0, sp);
    }
    return null;
  }

  const stream = (client: string) => trimmed(['-F', '%Stream%', 'client', '-o', client]);

  interface Facts {
    exists: boolean;
    client: string | null;
    opened: number;
    shelved: number;
    /** Can't be waived with force. */
    hard: string | null;
  }

  async function facts(root: string): Promise<Facts> {
    const none = { client: null, opened: 0, shelved: 0 };
    if (!(await stat(root).then((s) => s.isDirectory(), () => false))) return { exists: false, ...none, hard: null };
    const client = await clientFor(root);
    if (!client) return { exists: true, ...none, hard: 'no p4 client of yours has this folder as its root' };
    if (!WH_CLIENT.test(client)) return { exists: true, ...none, hard: `${client} is not a work-hub client (…-wh-…)` };
    const [opened, shelved] = await Promise.all([p4(['-c', client, 'opened']).then(countOpened), p4(['changes', '-s', 'shelved', '-c', client]).then(countChanges)]);
    return { exists: true, client, opened, shelved, hard: null };
  }

  function blockOf(f: Facts, force: boolean): string | null {
    if (f.hard || force) return f.hard;
    const why = [f.opened ? plural(f.opened, 'file opened', 'files opened') : '', f.shelved ? plural(f.shelved, 'shelved changelist', 'shelved changelists') : ''].filter(Boolean);
    return why.length ? why.join(', ') : null;
  }

  return {
    id: 'p4',
    title: 'Perforce (p4)',
    experimental: true,
    detect: async (path) => {
      const root = await p4(['-d', path, '-F', '%clientRoot%', 'info'], path).then((s) => s.trim() || null, () => null);
      return root && isInside(root, path) ? root : null;
    },
    // The repo is the client's stream (`//Game/Main`); the line is the client itself, as `wh worktree add --branch` records it.
    identity: async (root) => {
      const client = await clientFor(root).catch(() => null);
      return { repo: client ? await stream(client) : null };
    },
    line: async (root) => {
      const client = await clientFor(root).catch(() => null);
      if (!client) return { line: null, head: null };
      return { line: client, head: await trimmed(['-c', client, '-F', '%change%', 'changes', '-m1', `//${client}/...#have`]) };
    },
    sharedLines: new Set<string>(),
    inspect: async (root): Promise<WorkingCopyState> => {
      const f = await facts(root);
      const block = blockOf(f, false);
      return { exists: f.exists, dirty: f.opened > 0, unsaved: f.shelved, removable: block === null, block };
    },
    removeWorkingCopy: async (root, { force }) => {
      const f = await facts(root);
      if (!f.exists) return; // nothing on disk: only the record goes
      const block = blockOf(f, force);
      if (block || !f.client) throw new Error(`can't remove ${root}: ${block ?? 'no client'}`);
      // Forced: opened files are reverted so the client can go (p4 still refuses one with shelved files).
      if (f.opened) await p4(['-c', f.client, 'revert', `//${f.client}/...`]);
      await p4(['client', '-d', f.client]);
      await rm(root, { recursive: true, force: true });
    },
    agentInstructions: (o) => {
      const ticket = ticketName(o.ticketKey);
      const path = shq(`${o.worktreesDir}/<template>/${ticket ?? '<short-kebab-desc>'}`);
      const choose = templates.length
        ? `Copy one of these template clients (<template> is its name, <template client> its client): ${templates.map((t) => `\`${t.name}\` (\`${t.client}\`)`).join(', ')}.`
        : "No template clients are configured (the p4 plugin's `templates` setting): ask the user which existing client to copy, and use it as <template client> and a short name for it as <template>.";
      return [
        `Working copies are Perforce (p4) client workspaces (experimental), one client per copy: <client> is \`<user>-wh-${o.workspaceId}\` (<user>: \`p4 -F %userName% info\`; a second p4 copy in this workspace: \`<user>-wh-${o.workspaceId}-<template>\`), rooted at \`${path}\`${ticket ? '' : ' (<short-kebab-desc>: a short kebab-case name for the task)'}. Run p4 in a copy as \`p4 -c <client> …\`.`,
        choose,
        `\`p4 client -t <template client> -o <client> | R=${path} awk '/^Root:/ { print "Root:\\t" ENVIRON["R"]; next } 1' | p4 client -i\``,
        `\`mkdir -p ${path} && cd ${path} && p4 -c <client> sync && echo "P4CLIENT=<client>" > ${shq(p4config)}\`, then \`${o.whCommand} trust ${path}\``,
        `\`${o.whCommand} worktree add ${o.workspaceId} --path ${path} --vcs p4 --branch <client>\``,
      ];
    },
    prereq: () =>
      p4(['-V']).then(
        (s) => ({ ok: true, detail: s.trim().split('\n').find((l) => l.startsWith('Rev.')) ?? s.trim().split('\n')[0] ?? 'p4' }),
        (e: unknown) => ({ ok: false, detail: `p4 not found: ${e instanceof Error ? e.message : String(e)}` }),
      ),
  };
}
