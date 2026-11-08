import { spawn, type ChildProcess } from 'node:child_process';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { isAcceptedOrigin, type Session } from '../../plugin-api/server.ts';
import { ptyBridgeCommand } from '../../plugin-api/platform.ts';

/**
 * Live terminal: while a session page is open, the browser holds a WebSocket and the server keeps one
 * `claude attach <id>` running in a pseudo-terminal (ptybridge.py) for it, streaming output straight
 * through and typing whatever the browser sends. Several viewers can attach to one job at once; the
 * terminal size is shared (the last viewer to resize sets it for all attached clients).
 *
 * Messages from the browser are JSON: {t:'in', d:string} to type, {t:'resize', cols, rows}.
 * The server sends terminal output as binary frames and {t:'exit'} when the attach ends.
 */

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => (Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.floor(Number(n)))) : dflt);

export function registerLiveTerminal(opts: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  /** The core's pty bridge (`server/lib/ptybridge.py`): a path, not an import. */
  bridge: string;
  findSession: (id: string) => Promise<Session | undefined>;
}): void {
  const { app, upgradeWebSocket, bridge, findSession } = opts;
  app.get('/api/sessions/:id/term', async (c, next) => {
    // Browsers don't apply same-origin rules to WebSockets, so check the Origin ourselves (the global
    // guard only checks it on writes). Host and sign-in cookie were already checked by the guard.
    // A WebSocket from an origin the app isn't served at gets 403 (isAcceptedOrigin: the hostname, or localhost).
    if (!isAcceptedOrigin(c.req.header('origin'))) return c.text('forbidden origin', 403);
    const s = await findSession(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    if (s.kind !== 'background') return c.json({ error: 'live terminal is only for background sessions' }, 409);
    c.set('liveSession' as never, s as never);
    return next();
  }, upgradeWebSocket((c) => {
    const s = c.get('liveSession' as never) as unknown as Session;
    const cols = clamp(c.req.query('cols'), 20, 400, 120);
    const rows = clamp(c.req.query('rows'), 5, 200, 40);
    let child: ChildProcess | null = null;

    return {
      onOpen(_evt, ws) {
        const cmd = ptyBridgeCommand(bridge, cols, rows, ['claude', 'attach', s.shortId]);
        child = spawn(cmd.cmd, cmd.args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
        child.stdout!.on('data', (d: Buffer) => ws.send(new Uint8Array(d)));
        child.on('exit', () => {
          try {
            ws.send(JSON.stringify({ t: 'exit' }));
            ws.close();
          } catch {
            /* already closed */
          }
        });
      },
      onMessage(evt) {
        if (!child || typeof evt.data !== 'string') return;
        let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (msg.t === 'in' && typeof msg.d === 'string') child.stdin!.write(msg.d);
        if (msg.t === 'resize') {
          const control = child.stdio[3] as NodeJS.WritableStream | null;
          control?.write(`${clamp(msg.cols, 20, 400, cols)} ${clamp(msg.rows, 5, 200, rows)}\n`);
        }
      },
      onClose() {
        // Closing stdin makes the bridge hang up `claude attach` (a clean detach); the job keeps running.
        const ch = child;
        child = null;
        if (!ch) return;
        ch.stdin?.end();
        setTimeout(() => ch.exitCode === null && ch.kill('SIGTERM'), 2000);
      },
    };
  }));
}
