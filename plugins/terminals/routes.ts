import { request } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isWindows } from '../../plugin-api/platform.ts';
import type { WSContext } from 'hono/ws';
import WebSocket from 'ws';
import { invalidCommand, isAcceptedOrigin, sessionDirs, type ServerPluginContext } from '../../plugin-api/server.ts';
import type { TerminalRuns } from './terminalRuns.ts';
import { classifyProbe, probeSocket } from './probe.ts';

/**
 * The Terminal tab: proxies to the terminal daemon (termd.ts) on its unix socket, behind this
 * server's sign-in. The shells live in the daemon, so restarting this server doesn't end them.
 */

/** A terminal as the daemon describes it. */
export interface TermInfo {
  id: string;
  title: string;
  custom: boolean;
  createdAt: number;
  alive: boolean;
  workspace: string | null;
  cwd: string;
}

/** The `terminals` service (ctx.services.get('terminals')): what a `!` command card's "▶ Terminal" needs. */
export interface TerminalsService {
  /**
   * Open a new terminal of the workspace in `cwd` (one of its folders; empty = the first) and type `command` + Enter.
   * With `sessionId`, it runs through bin/wh-term-run so its output and exit code land on a command_runs row (`runId`).
   */
  runInTerminal(workspaceId: string, cwd: string | undefined, command: string, opts?: { sessionId?: string; cols?: number; rows?: number }): Promise<TermInfo & { runId?: number }>;
}

/** A 4xx from runInTerminal (bad input), as opposed to the daemon failing (503). */
export class TerminalRequestError extends Error {
  status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}

export interface TerminalRoutesOpts {
  socket: string;
  runs: TerminalRuns;
}

function termd(socket: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method, headers: { 'content-type': 'application/json' }, timeout: 10_000 }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 500, json: JSON.parse(s) });
        } catch {
          resolve({ status: 502, json: { error: 'bad reply from the terminal daemon' } });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('terminal daemon timed out')));
    req.on('error', (e) => reject(new Error(`terminal daemon unreachable (${(e as NodeJS.ErrnoException).code ?? e.message}); is termd running (see the terminals plugin's README)?`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const ID = /^[0-9a-f]{1,16}$/;

/**
 * Type a command (and Enter) into a terminal, over the daemon's attach socket like a browser tab would, then detach.
 * Typed before the login shell is ready, it waits in the pty's input buffer until the shell reads it.
 */
function typeIntoTerm(socket: string, id: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix://${socket}:/terms/${id}/attach`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('terminal daemon timed out'));
    }, 10_000);
    // The daemon sends the screen first, then listens: type once that arrives.
    ws.once('message', () => {
      ws.send(JSON.stringify({ t: 'in', d: text }));
      setTimeout(() => {
        clearTimeout(timer);
        ws.close();
        resolve();
      }, 300);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * No daemon on the socket, so one may be started: only when the socket is missing or stale (probe.ts). A timeout or an
 * odd reply counts as present, so a slow daemon is never replaced by a second one.
 */
export async function termdAbsent(socket: string): Promise<boolean> {
  return classifyProbe(await probeSocket(socket)) === 'absent';
}

/**
 * What Settings says about new terminals, read for each one: the shell (empty = the daemon's own: your login shell), its
 * arguments (split on spaces; `-l` by default) and how much history to keep. The daemon ignores what it doesn't know, so
 * an older one just runs its defaults.
 */
export function newTerminalOptions(ctx: ServerPluginContext, windows = isWindows()): { shell?: string; shellArgs?: string[]; scrollback: number } {
  const shell = String(ctx.config.get('shell', '') ?? '').trim();
  const args = String(ctx.config.get('shellArgs', '-l') ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Windows: the default `-l` means nothing to PowerShell; leave it to the daemon's own (-NoLogo) unless a shell is set.
  const keepArgs = !windows || !!shell || args.join(' ') !== '-l';
  return { ...(shell ? { shell } : {}), ...(keepArgs ? { shellArgs: args } : {}), scrollback: Number(ctx.config.get('scrollback', 5000)) || 5000 };
}

/** Where a terminal in the general Terminal tab starts: the `startDir` setting (`~` allowed), else the daemon's default (home). */
export function generalStartDir(ctx: ServerPluginContext): string | undefined {
  const raw = String(ctx.config.get('startDir', '') ?? '').trim();
  if (!raw) return undefined;
  const dir = raw === '~' ? homedir() : /^~[\\/]/.test(raw) ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(dir) ? dir : undefined;
}

/** The `startupCommand` setting, typed (with Enter) into a new terminal once it is up; empty = nothing. */
function startupCommand(ctx: ServerPluginContext): string {
  const c = String(ctx.config.get('startupCommand', '') ?? '').trim();
  return c && !invalidCommand(c) ? c : '';
}

/** The `terminals` service over the daemon; the workspace route below goes through it too. */
export function terminalsService(ctx: ServerPluginContext, opts: TerminalRoutesOpts): TerminalsService {
  const { socket, runs } = opts;
  return {
    async runInTerminal(workspaceId, cwdIn, command, o = {}) {
      const ws = ctx.store.getWorkspace(workspaceId);
      if (!ws) throw new TerminalRequestError('no such workspace', 404);
      const dirs = sessionDirs(ws);
      const cwd = cwdIn || dirs[0]!;
      if (!dirs.includes(cwd)) throw new TerminalRequestError(`not one of this workspace's folders: ${cwd}`);
      const bad = invalidCommand(command);
      if (bad) throw new TerminalRequestError(bad);
      if (o.sessionId !== undefined && !/^[0-9a-f-]{8,64}$/.test(o.sessionId)) throw new TerminalRequestError('sessionId required');
      const r = await termd(socket, 'POST', '/terms', { cols: o.cols, rows: o.rows, cwd, workspace: ws.id, ...newTerminalOptions(ctx) });
      const term = r.json as TermInfo & { error?: string };
      if (r.status !== 200 || !term.id) throw Object.assign(new Error(term.error ?? `terminal daemon answered ${r.status}`), { reply: r });
      if (!o.sessionId) {
        await typeIntoTerm(socket, term.id, `${command.trim()}\r`);
        return term;
      }
      const { runId, line } = await runs.start(o.sessionId, ws.id, command.trim());
      runs.noteTerminal(runId, term.id);
      await typeIntoTerm(socket, term.id, `${line}\r`);
      return { ...term, runId };
    },
  };
}

export function registerTerminalRoutes(ctx: ServerPluginContext, opts: TerminalRoutesOpts, service: TerminalsService): void {
  const { app, upgradeWebSocket } = ctx;
  const { socket } = opts;
  /** `then`: a command to type into the terminal the daemon just created (the startupCommand setting). */
  const relay = async (c: { json: (o: unknown, s?: number) => Response }, method: string, path: string, body?: unknown, then = '') => {
    try {
      const r = await termd(socket, method, path, body);
      const id = (r.json as { id?: unknown } | null)?.id;
      if (then && r.status === 200 && typeof id === 'string') await typeIntoTerm(socket, id, `${then}\r`).catch(() => {});
      return c.json(r.json, r.status as 200);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 503);
    }
  };

  // The general Terminal tab: terminals that belong to no workspace.
  app.get('/api/terms', (c) => relay(c, 'GET', '/terms?workspace='));
  app.post('/api/terms', async (c) => {
    const b = await c.req.json<{ cols?: number; rows?: number }>().catch(() => ({}) as { cols?: number; rows?: number });
    return relay(c, 'POST', '/terms', { cols: b.cols, rows: b.rows, cwd: generalStartDir(ctx), ...newTerminalOptions(ctx) }, startupCommand(ctx));
  });

  // A workspace's terminals, starting in one of its folders (its worktrees or the worktrees root).
  app.get('/api/workspaces/:id/terms', async (c) => {
    if (!ctx.store.getWorkspace(c.req.param('id'))) return c.json({ error: 'no such workspace' }, 404);
    return relay(c, 'GET', `/terms?workspace=${encodeURIComponent(c.req.param('id'))}`);
  });
  app.post('/api/workspaces/:id/terms', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    type Body = { cols?: number; rows?: number; cwd?: string; run?: string; sessionId?: string };
    const b = await c.req.json<Body>().catch(() => ({}) as Body);
    const dirs = sessionDirs(ws);
    const cwd = b.cwd || dirs[0]!;
    if (!dirs.includes(cwd)) return c.json({ error: `not one of this workspace's folders: ${cwd}` }, 400);
    if (b.run === undefined) return relay(c, 'POST', '/terms', { cols: b.cols, rows: b.rows, cwd, workspace: ws.id, ...newTerminalOptions(ctx) }, startupCommand(ctx));
    // `run`: a script Claude handed you (its card's Terminal button), run via bin/wh-term-run so its output is
    // saved on a command_runs row for `sessionId` (see terminalRuns.ts).
    const bad = invalidCommand(b.run);
    if (bad) return c.json({ error: bad }, 400);
    if (typeof b.sessionId !== 'string' || !/^[0-9a-f-]{8,64}$/.test(b.sessionId)) return c.json({ error: 'sessionId required' }, 400);
    try {
      return c.json(await service.runInTerminal(ws.id, cwd, b.run, { sessionId: b.sessionId, cols: b.cols, rows: b.rows }));
    } catch (e) {
      if (e instanceof TerminalRequestError) return c.json({ error: e.message }, e.status);
      // The daemon's own refusal is passed on as it came.
      const reply = (e as { reply?: { status: number; json: unknown } }).reply;
      if (reply) return c.json(reply.json, reply.status as 200);
      return c.json({ error: (e as Error).message }, 503);
    }
  });
  app.post('/api/terms/:id/:action{close|restart|rename}', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'bad id' }, 400);
    const b = c.req.param('action') === 'rename' ? await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string }) : undefined;
    return relay(c, 'POST', `/terms/${id}/${c.req.param('action')}`, b && { title: b.title });
  });

  app.get('/api/terms/:id/ws', async (c, next) => {
    // Browsers don't apply same-origin rules to WebSockets, so check the Origin here (see live.ts).
    if (!isAcceptedOrigin(c.req.header('origin'))) return c.text('forbidden origin', 403);
    if (!ID.test(c.req.param('id'))) return c.text('bad id', 400);
    return next();
  }, upgradeWebSocket((c) => {
    const id = c.req.param('id');
    const q = new URLSearchParams({ cols: c.req.query('cols') ?? '', rows: c.req.query('rows') ?? '' });
    let up: WebSocket | null = null;
    const pending: string[] = [];
    const close = (ws: WSContext) => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    return {
      onOpen(_evt, ws) {
        up = new WebSocket(`ws+unix://${socket}:/terms/${id}/attach?${q}`);
        up.on('open', () => {
          for (const m of pending.splice(0)) up!.send(m);
        });
        up.on('message', (data, isBinary) => {
          if (isBinary) ws.send(new Uint8Array(data as Buffer));
          else ws.send(data.toString());
        });
        up.on('close', () => close(ws));
        up.on('error', () => close(ws));
      },
      onMessage(evt) {
        if (typeof evt.data !== 'string') return;
        if (up?.readyState === WebSocket.OPEN) up.send(evt.data);
        else if (pending.length < 100) pending.push(evt.data);
      },
      onClose() {
        up?.close();
        up = null;
      },
    };
  }));
}
