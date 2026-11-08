import { join } from 'node:path';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { createCollector, createGitLog } from './collect.ts';
import { renderDigest, type Digest, type DigestInput } from './digest.ts';
import { readDigest, removeDigest, writeDigest } from './files.ts';
import { launchArgs } from './hookSettings.ts';
import { rulesText, teamCommand } from './rules.ts';
import { watchDb } from './watch.ts';

const ROUTE = '/api/plugins/session-awareness/workspaces/:id/digest';

/** The github plugin's service, structurally (plugins don't import each other). */
interface GithubLike {
  data(): { mine: DigestInput['prs']; reviewRequested: DigestInput['prs'] } | null;
}

/**
 * Keeps one digest per workspace (a block per open session) and rebuilds it only when something changes: in-process
 * events, the `claude` / `github` sources, and the database file (for `wh claim` & co., which run in their own
 * process). Serves it to the UI, adds it to start prompts, and names the `wh claim` / `wh done` rules.
 */
export default function register(ctx: ServerPluginContext): void {
  const dir = ctx.paths.pluginState;
  const settings = () => ({
    maxBlockChars: ctx.config.get('maxBlockChars', 600),
    staleAfterMs: ctx.config.get('staleAfterMs', 600_000),
    startPrompt: ctx.config.get('startPrompt', true),
  });
  const debounceMs = ctx.config.get('rebuildDebounceMs', 2000);
  /** When the claude source last changed: status and PR facts are that fresh. */
  let liveAt: number | null = null;
  /** The last digest built per workspace (what the route and the start-prompt fragment read). */
  const latest = new Map<string, Digest>();
  /** What is on disk per workspace: the block versions and liveAt last written, so rewrites compare to the file, not to the previous build. */
  const written = new Map<string, { key: string; liveAt: number | null }>();
  const keyOf = (d: Digest) => d.blocks.map((b) => `${b.sessionId}:${b.version}`).join(',');

  const gitLog = createGitLog((cmd, args, o) => ctx.exec.run(cmd, args, o), (cwd, base) => ctx.git.baseRef(cwd, base));
  const collector = createCollector({
    getWorkspace: (id) => ctx.store.getWorkspace(id),
    listEvents: (id, o) => ctx.store.listEvents(id, o),
    liveSessions: () => ctx.sessions.list(),
    liveAt: () => liveAt,
    boundWorktrees: (id) => ctx.sessions.boundWorktrees(id),
    sessionEdits: (id) => ctx.sessions.sessionEdits(id),
    prs: () => {
      const gh = ctx.services.get<GithubLike | undefined>('github')?.data();
      return gh ? [...gh.mine, ...gh.reviewRequested] : [];
    },
    gitLog,
    settings,
  });

  // Rebuilds: debounced per workspace, run one at a time (git and transcript reads), unchanged results not rewritten.
  const timers = new Map<string, NodeJS.Timeout>();
  let chain: Promise<void> = Promise.resolve();
  async function doRebuild(wsId: string): Promise<void> {
    const d = await collector.collect(wsId);
    if (!d) {
      written.delete(wsId);
      if (latest.delete(wsId) || (await readDigest(dir, wsId))) await removeDigest(dir, wsId);
      return;
    }
    let onDisk = written.get(wsId);
    if (!onDisk) {
      const file = await readDigest(dir, wsId);
      if (file) written.set(wsId, (onDisk = { key: keyOf(file), liveAt: file.liveAt }));
    }
    latest.set(wsId, d);
    const sameBlocks = !!onDisk && onDisk.key === keyOf(d);
    const sameLive = !!onDisk && (onDisk.liveAt ?? 0) + 60_000 > (d.liveAt ?? 0);
    if (sameBlocks && sameLive) return;
    await writeDigest(dir, d, renderDigest(d, { staleAfterMs: settings().staleAfterMs, now: d.builtAt }));
    written.set(wsId, { key: keyOf(d), liveAt: d.liveAt });
  }
  const rebuild = (wsId: string) => {
    const t = timers.get(wsId);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      timers.delete(wsId);
      chain = chain.then(() => doRebuild(wsId)).catch((e) => ctx.log.error(`digest ${wsId}:`, e));
    }, debounceMs);
    timer.unref();
    timers.set(wsId, timer);
  };
  const rebuildAll = () => {
    const ids = new Set([...ctx.store.listWorkspaces().map((w) => w.id), ...latest.keys()]);
    for (const id of ids) rebuild(id);
  };

  ctx.events.on('workspace-event', ({ workspaceId }) => rebuild(workspaceId));
  ctx.events.on('session-started', () => rebuildAll());
  ctx.events.on('session-stopped', () => rebuildAll());
  ctx.events.on('source-changed', ({ id }) => {
    if (id === 'claude') liveAt = Date.now();
    if (id === 'claude' || id === 'github') rebuildAll();
  });

  let stopWatch: (() => void) | null = null;
  ctx.onStart(() => {
    const dbPath = process.env.WORK_HUB_DB ?? join(ctx.paths.stateDir, 'hub.db');
    stopWatch = watchDb(dbPath, () => rebuildAll());
    rebuildAll();
  });
  process.once('exit', () => stopWatch?.());

  // Sessions the app starts get the nudge hook, for that session only (settings read per launch, so a change applies next time).
  const hookPath = join(ctx.pluginDir, 'claude', 'hooks', 'awareness.mjs');
  ctx.sessions.addLaunchArgs(() => launchArgs({ hookPath, stateDir: dir, nudgeIntervalMs: ctx.config.get('nudgeIntervalMs', 300_000), staleAfterMs: settings().staleAfterMs }));

  ctx.revalidate([ROUTE]);
  ctx.app.get(ROUTE, async (c) => {
    const id = c.req.param('id');
    // Only real workspace ids reach the disk (the param is user input; a traversal-shaped id must not name a file).
    if (!ctx.store.getWorkspace(id)) return c.json({ error: 'no digest' }, 404);
    const d = latest.get(id) ?? (await readDigest(dir, id));
    if (!d) return c.json({ error: 'no digest' }, 404);
    return c.json(d);
  });

  // Fragments last: they can't be taken back if register() throws (CLAUDE.md), so nothing above may follow them.
  ctx.prompts.addFragment('session-context', ({ workspaceId, excludeSessionId }) => {
    if (!workspaceId || !settings().startPrompt) return null;
    const d = latest.get(workspaceId);
    if (!d) return null;
    // The starting session doesn't exist yet, so every block is a sibling; a handoff names the session it replaces.
    const md = renderDigest(d, { excludeSessionId: typeof excludeSessionId === 'string' ? excludeSessionId : undefined, staleAfterMs: settings().staleAfterMs, now: Date.now() });
    return md ? `## Other sessions in this workspace\n\n${md}` : null;
  });
  ctx.prompts.addFragment('workspace-rules', () => rulesText(ctx.paths.whCommand, teamCommand(dir, ctx.pluginDir)));
}
