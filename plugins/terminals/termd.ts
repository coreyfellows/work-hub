import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Terminal as TerminalType } from '@xterm/headless';
import type { SerializeAddon as SerializeType } from '@xterm/addon-serialize';
import { classifyProbe, probeSocket } from './probe.ts';
import { logRotator, rotateLog } from './logRotate.ts';
import { defaultShell, defaultTermdSocket, isExecutableFile, isNamedPipe, ptyBridgeCommand } from '../../plugin-api/platform.ts';

/**
 * Terminal daemon for the Terminal tab: owns the shells (each in a pty via lib/ptybridge.py) so they
 * survive restarts of the main server, and mirrors each into a headless xterm so a reconnecting browser
 * gets the screen and scrollback back. History is also written to disk, so after the daemon itself
 * restarts (or a reboot) the old text is still shown and the tab can start a fresh shell under it.
 *
 * Runs as its own process (started by the plugin's onStart when its socket doesn't answer, or by an optional
 * launchd agent, see README.md) and listens only on a unix socket in the 0700 state dir; the main server
 * (routes.ts) proxies to it behind its sign-in. Standalone on purpose: it imports nothing from the app, and
 * takes its paths from the env (the plugin passes the ones it resolved), defaulting to the same ones.
 *
 * Env: WORK_HUB_TERMD_SOCKET (default <state>/termd.sock), WORK_HUB_TERMS_DIR (<state>/terms), WORK_HUB_TERMD_BRIDGE
 * (the core's server/lib/ptybridge.py), WORK_HUB_TERM_SHELL; <state> = WORK_HUB_STATE_DIR, else $XDG_STATE_HOME/work-hub.
 *
 * HTTP: GET /terms, POST /terms {cols,rows}, POST /terms/:id/{close,restart,rename {title}}
 * WS /terms/:id/attach?cols&rows: first a binary snapshot (serialized screen + scrollback), then live
 * output; from the browser JSON {t:'in',d} / {t:'resize',cols,rows}; to it {t:'exit'} when the shell ends.
 */

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as { Terminal: typeof TerminalType };
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: typeof SerializeType };

const env = process.env;
const stateDir = env.WORK_HUB_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'work-hub');
const TERMD_SOCKET = env.WORK_HUB_TERMD_SOCKET || defaultTermdSocket(stateDir);
// A named pipe (Windows) isn't in a folder: the state dir is where the daemon keeps its files then.
const PIPE = isNamedPipe(TERMD_SOCKET);
const STATE = PIPE ? stateDir : dirname(TERMD_SOCKET);
const DIR = env.WORK_HUB_TERMS_DIR || join(stateDir, 'terms');
// The pty bridge is shared with the core's `claude attach` typing (server/lib/ptybridge.py); a path, not an import.
const BRIDGE = env.WORK_HUB_TERMD_BRIDGE || resolve(import.meta.dirname, '../../server/lib/ptybridge.py');
const SCROLLBACK = 5000;
const DEFAULT_SHELL = defaultShell();
const SHELL = process.env.WORK_HUB_TERM_SHELL || DEFAULT_SHELL.shell;
// `-l` (a login shell) on macOS and Linux; `-NoLogo` for PowerShell on Windows.
const SHELL_ARGS = process.env.WORK_HUB_TERM_SHELL ? (process.platform === 'win32' ? [] : ['-l']) : DEFAULT_SHELL.args;

/** A shell the create request asks for: an absolute path to an executable file, else null (the default shell runs). */
function usableShell(v: unknown): string | null {
  return typeof v === 'string' && isAbsolute(v) && isExecutableFile(v) ? v : null;
}
/** Shell arguments from a create request: up to 8 short strings; anything else means the default (`-l`). */
function shellArgsOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 8 || v.some((a) => typeof a !== 'string' || a.length > 200 || a.includes('\0'))) return null;
  return v as string[];
}

const clamp = (n: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.floor(Number(n)))) : d);

interface Term {
  id: string;
  title: string; // set by you, or '' to use the shell's own title
  shellTitle: string;
  createdAt: number;
  /** The work-hub workspace it belongs to (null: the general Terminal tab), and where its shell starts. */
  workspace: string | null;
  cwd: string;
  cols: number;
  rows: number;
  /** What its shell runs (a create request's `shell`/`shellArgs`; the defaults otherwise) and how much history it keeps. */
  shell: string;
  shellArgs: string[];
  scrollback: number;
  child: ChildProcess | null;
  head: TerminalType;
  ser: SerializeType;
  clients: Set<WebSocket>;
  dirty: boolean;
}

const terms = new Map<string, Term>();
let counter = 0;

function mirror(cols: number, rows: number, scrollback: number) {
  const head = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const ser = new SerializeAddon();
  head.loadAddon(ser as never);
  return { head, ser };
}

function broadcast(t: Term, data: Buffer | string) {
  for (const ws of t.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function startShell(t: Term) {
  const cmd = ptyBridgeCommand(BRIDGE, t.cols, t.rows, [t.shell, ...t.shellArgs]);
  const child = spawn(cmd.cmd, cmd.args, {
    windowsHide: true,
    cwd: existsSync(t.cwd) ? t.cwd : homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WORK_HUB_TERMINAL: t.id },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  t.child = child;
  child.stdout!.on('data', (d: Buffer) => {
    t.head.write(d);
    t.dirty = true;
    broadcast(t, d);
  });
  child.on('exit', () => {
    if (t.child !== child) return;
    t.child = null;
    t.head.write('\r\n\x1b[2m[shell exited]\x1b[0m\r\n');
    t.dirty = true;
    broadcast(t, JSON.stringify({ t: 'exit' }));
  });
}

interface Saved {
  id: string;
  title: string;
  createdAt: number;
  snapshot: string;
  workspace?: string | null;
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  scrollback?: number;
}

interface Opts {
  shell?: string | null;
  shellArgs?: string[] | null;
  scrollback?: number;
}

function create(cols: number, rows: number, restored?: Saved, place?: { workspace: string | null; cwd: string }, opts: Opts = {}): Term {
  const scrollback = clamp(restored ? restored.scrollback : opts.scrollback, 500, 100_000, SCROLLBACK);
  const { head, ser } = mirror(cols, rows, scrollback);
  const t: Term = {
    id: restored?.id ?? randomBytes(4).toString('hex'),
    title: restored?.title ?? '',
    shellTitle: '',
    createdAt: restored?.createdAt ?? Date.now(),
    workspace: restored ? (restored.workspace ?? null) : (place?.workspace ?? null),
    cwd: (restored ? restored.cwd : place?.cwd) || homedir(),
    cols,
    rows,
    shell: (restored ? usableShell(restored.shell) : usableShell(opts.shell)) ?? SHELL,
    shellArgs: (restored ? shellArgsOf(restored.shellArgs) : shellArgsOf(opts.shellArgs)) ?? SHELL_ARGS,
    scrollback,
    child: null,
    head,
    ser,
    clients: new Set(),
    dirty: true,
  };
  head.onTitleChange((s) => (t.shellTitle = s));
  if (restored) head.write(restored.snapshot);
  terms.set(t.id, t);
  return t;
}

function resize(t: Term, cols: number, rows: number) {
  if (cols === t.cols && rows === t.rows) return;
  t.cols = cols;
  t.rows = rows;
  t.head.resize(cols, rows);
  (t.child?.stdio[3] as NodeJS.WritableStream | null)?.write(`${cols} ${rows}\n`);
}

const info = (t: Term) => ({
  id: t.id,
  title: t.title || t.shellTitle || '',
  custom: !!t.title,
  createdAt: t.createdAt,
  alive: !!t.child,
  workspace: t.workspace,
  cwd: t.cwd,
});

// --- persistence -------------------------------------------------------------------------------
function save(t: Term) {
  const file = join(DIR, `${t.id}.json`);
  const body = JSON.stringify({ id: t.id, title: t.title, createdAt: t.createdAt, workspace: t.workspace, cwd: t.cwd, cols: t.cols, rows: t.rows, shell: t.shell, shellArgs: t.shellArgs, scrollback: t.scrollback, snapshot: t.ser.serialize({ scrollback: t.scrollback }) });
  writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  t.dirty = false;
}
function saveAll(force = false) {
  for (const t of terms.values()) if (force || t.dirty) {
    try {
      save(t);
    } catch (e) {
      console.error('save failed', t.id, (e as Error).message);
    }
  }
}
function restore() {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
      const t = create(clamp(r.cols, 20, 400, 100), clamp(r.rows, 5, 200, 30), r);
      t.head.write('\r\n\x1b[2m[restored after a restart; the shell has ended]\x1b[0m\r\n');
    } catch (e) {
      console.error('restore failed', f, (e as Error).message);
    }
  }
}

// --- HTTP + WS on the unix socket -----------------------------------------------------------
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) s += c;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
function send(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://termd');
  const m = url.pathname.match(/^\/terms(?:\/([0-9a-f]+)(?:\/(close|restart|rename))?)?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const [, id, action] = m;
  if (!id && req.method === 'GET') {
    // ?workspace=<id> lists that workspace's terminals; ?workspace= (empty) the general ones; no param, all.
    const ws = url.searchParams.get('workspace');
    const list = [...terms.values()].filter((t) => ws === null || t.workspace === (ws || null));
    return send(res, 200, list.sort((a, b) => a.createdAt - b.createdAt).map(info));
  }
  if (!id && req.method === 'POST') {
    const b = await body(req);
    const workspace = typeof b.workspace === 'string' && b.workspace ? b.workspace : null;
    const cwd = typeof b.cwd === 'string' && isAbsolute(b.cwd) ? b.cwd : homedir();
    const t = create(clamp(b.cols, 20, 400, 100), clamp(b.rows, 5, 200, 30), undefined, { workspace, cwd }, { shell: b.shell as string, shellArgs: b.shellArgs as string[], scrollback: b.scrollback as number });
    t.title = workspace ? basename(cwd) : `Terminal ${++counter}`;
    startShell(t);
    return send(res, 200, info(t));
  }
  const t = id ? terms.get(id) : undefined;
  if (!t) return send(res, 404, { error: 'no such terminal' });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (action === 'close') {
    const child = t.child;
    t.child = null;
    child?.stdin?.end(); // the bridge exits and the shell gets SIGHUP
    if (child) setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000);
    for (const ws of t.clients) ws.close();
    terms.delete(t.id);
    rmSync(join(DIR, `${t.id}.json`), { force: true });
    return send(res, 200, { ok: true });
  }
  if (action === 'restart') {
    if (!t.child) {
      t.head.write('\r\n\x1b[2m[new shell]\x1b[0m\r\n');
      startShell(t);
      broadcast(t, JSON.stringify({ t: 'restarted' }));
    }
    return send(res, 200, info(t));
  }
  if (action === 'rename') {
    const b = await body(req);
    t.title = typeof b.title === 'string' ? b.title.trim().slice(0, 60) : '';
    t.dirty = true;
    return send(res, 200, info(t));
  }
  return send(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://termd');
  const m = url.pathname.match(/^\/terms\/([0-9a-f]+)\/attach$/);
  const t = m ? terms.get(m[1]) : undefined;
  if (!t) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    resize(t, clamp(url.searchParams.get('cols'), 20, 400, t.cols), clamp(url.searchParams.get('rows'), 5, 200, t.rows));
    // Snapshot after the resize so it's laid out for this viewer; write() is async, so wait for it to settle.
    t.head.write('', () => {
      ws.send(Buffer.from(t.ser.serialize({ scrollback: t.scrollback }), 'utf8'));
      if (!t.child) ws.send(JSON.stringify({ t: 'exit' }));
      t.clients.add(ws);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'in' && typeof msg.d === 'string') t.child?.stdin?.write(msg.d);
      if (msg.t === 'resize') resize(t, clamp(msg.cols, 20, 400, t.cols), clamp(msg.rows, 5, 200, t.rows));
    });
    ws.on('close', () => t.clients.delete(ws));
  });
});

// One daemon per socket: if something already holds it, leave it alone (unlinking it would orphan that daemon's shells).
// Only a missing socket or a stale one (ECONNREFUSED, left by a crash) may be replaced.
const existing = classifyProbe(await probeSocket(TERMD_SOCKET));
if (existing === 'answered') {
  console.log(`termd already running on ${TERMD_SOCKET}`);
  process.exit(0);
}
if (existing === 'unclear') {
  console.error(`termd: something holds ${TERMD_SOCKET} but didn't answer like termd; not taking it over`);
  process.exit(1);
}
mkdirSync(DIR, { recursive: true, mode: 0o700 });
mkdirSync(STATE, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') chmodSync(STATE, 0o700);
// The file this daemon's output goes to (the plugin's autostart and the launchd agent say which): over 5 MB, keep one old
// copy. Checked at start and on every save tick, rotating at most once an hour while the daemon runs.
const rotateTick = env.WORK_HUB_TERMD_LOG
  ? logRotator(env.WORK_HUB_TERMD_LOG, { rotatedAt: rotateLog(env.WORK_HUB_TERMD_LOG) ? Date.now() : undefined })
  : () => false;
restore();
counter = [...terms.values()].filter((t) => !t.workspace).length;
if (!PIPE) {
  try {
    unlinkSync(TERMD_SOCKET);
  } catch {
    /* not there */
  }
}
// A Windows named pipe gets the default pipe ACL (only this user, SYSTEM and admins may write to it); a socket file 0600.
server.listen(TERMD_SOCKET, () => {
  if (!PIPE) chmodSync(TERMD_SOCKET, 0o600);
  console.log(`termd on ${TERMD_SOCKET} (${terms.size} restored)`);
});
setInterval(() => {
  saveAll();
  rotateTick();
}, 10_000).unref();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    saveAll(true);
    for (const t of terms.values()) t.child?.stdin?.end();
    if (!PIPE) {
      try {
        unlinkSync(TERMD_SOCKET);
      } catch {
        /* already gone */
      }
    }
    process.exit(0);
  });
}
