import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { invalidCommand, readJson, type ServerPluginContext, type Session } from '../../../plugin-api/server.ts';
import { runStore } from './commandRuns.ts';
import { runQueue } from './runCommand.ts';
import { commandCandidates, insideRoots } from './shared/scriptPath.ts';
import { shellEnricher, shellOutputs } from './shell.ts';

export type { CommandRun, CommandRunStatus } from './types.ts';

export default function register(ctx: ServerPluginContext): void {
  // Tables exist from the core's migrations 4-6 (command_runs); nothing of our own yet.
  ctx.db.migrate([]);
  // The cards poll a session's runs every 3s while one is queued: an unchanged poll is an empty 304.
  ctx.revalidate(['/api/sessions/:id/run']);

  const lookup = (id: string): Session | undefined => ctx.sessions.list().find((s) => s.sessionId === id || s.shortId === id);
  /** A fresh session lookup for the run queue: the cached list can lag Claude finishing its turn. */
  const freshSession = async (id: string): Promise<Session | undefined> => {
    await ctx.registry.refresh('claude').catch(() => {});
    return lookup(id);
  };

  const outputs = shellOutputs(ctx.sessions.transcriptState);
  const store = runStore({ db: () => ctx.db.raw(), logEvent: (ws, type, detail) => ctx.store.logEvent(ws, type, detail) });
  const queue = runQueue({
    store,
    typeSequence: ctx.sessions.typeSequence,
    KEY_BYTES: ctx.sessions.KEY_BYTES,
    openQuestion: ctx.sessions.openQuestion,
    shellOutputSince: outputs.since,
    alreadyRan: outputs.ran,
    log: (msg) => console.log(msg),
    logError: (msg, err) => console.error(msg, err),
  });

  // `!` runs in the transcript become one user entry with `shell` (command, output, stderr).
  ctx.transcript.addEnricher(shellEnricher);

  /**
   * Run a command in the session's own shell, like typing `! <command>` at its prompt (output lands in the
   * conversation). Runs now if Claude is at its prompt, else queues it (durably, in command_runs) until it is.
   * `cancel: true` drops a queued one. Responds with the session's runs, as GET does.
   */
  ctx.app.post('/api/sessions/:id/run', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    if (s.kind !== 'background') return c.json({ error: 'interactive sessions can only run commands in their own terminal' }, 409);
    const { command, cancel } = await readJson<{ command: string; cancel?: boolean }>(c);
    const bad = invalidCommand(command);
    if (bad) return c.json({ error: bad }, 400);
    if (cancel) return c.json({ ok: queue.cancelCommand(s.sessionId, command), runs: queue.commandRuns(s.sessionId) });
    try {
      const r = await queue.runCommand(s, command, freshSession);
      void ctx.registry.refresh('claude');
      return c.json({ ok: true, ...r, runs: queue.commandRuns(s.sessionId) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /** The latest Run of each command in the session (queued / ran / failed / cancelled / expired, with times). */
  ctx.app.get('/api/sessions/:id/run', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    return c.json({ runs: s ? queue.commandRuns(s.sessionId) : [] });
  });

  /** One Run's recorded result (the command, status and full output), for the output viewer. */
  ctx.app.get('/api/sessions/:id/run/:runId/output', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    const r = s ? store.runOutput(Number(c.req.param('runId'))) : null;
    if (!s || !r || r.sessionId !== s.sessionId) return c.json({ error: 'run not found' }, 404);
    return c.json(r);
  });

  /** A `!` run's full output from the transcript, by its history entry index (also covers commands pasted by hand). */
  ctx.app.get('/api/sessions/:id/shell-output', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    const out = s ? await outputs.at(s.sessionId, Number(c.req.query('i'))) : null;
    return out ? c.json(out) : c.json({ error: 'no output for that entry' }, 404);
  });

  /**
   * The script file behind a `!` command, for the card's "View script": the first path-like token that is a regular
   * text file under /tmp, the session's folder, the worktrees and repos folders (Settings → Folders) or a folder a plugin added with `ctx.files.addRoot` (resolved through symlinks first), at most 512KB.
   */
  ctx.app.get('/api/sessions/:id/script', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const command = c.req.query('command') ?? '';
    const cwd = s.cwd || homedir();
    const roots = await Promise.all(['/tmp', '/private/tmp', cwd, ctx.paths.worktreesDir, ctx.paths.reposDir, ...ctx.files.roots()].map((r) => realpath(r).catch(() => r)));
    for (const cand of commandCandidates(command)) {
      const abs = cand.startsWith('~/') ? resolve(homedir(), cand.slice(2)) : resolve(cwd, cand);
      const real = await realpath(abs).catch(() => null);
      if (!real || !insideRoots(real, roots)) continue;
      const st = await stat(real).catch(() => null);
      if (!st?.isFile()) continue;
      if (st.size > 512 * 1024) return c.json({ error: `${cand} is too large to show (${Math.round(st.size / 1024)} KB)` }, 413);
      const content = await readFile(real, 'utf8');
      if (content.includes('\0')) return c.json({ error: `${cand} isn't a text file` }, 415);
      return c.json({ path: real, content, bytes: st.size, mtime: st.mtime.toISOString() });
    }
    return c.json({ error: 'No script file found in this command (only files under /tmp, the session folder, ~/worktrees, ~/repos or the app-rules scripts folder are shown).' }, 404);
  });

  // Commands queued with the Run button before a restart still run once their session is at its prompt.
  ctx.onStart(() => queue.resumeQueues(freshSession));
}
