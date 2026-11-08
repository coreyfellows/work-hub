import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ptyBridgeCommand } from './platform.ts';

/**
 * Type into a background Claude job without any terminal app: briefly `claude attach` to it inside a
 * pseudo-terminal (ptybridge.py), wait for its screen to draw, type, then detach. Detaching only ends
 * the attach client; the job keeps running. One attach per job at a time.
 */

const BRIDGE = join(import.meta.dirname, 'ptybridge.py');

/** Terminal byte sequences for the keys the UI allows. */
export const KEY_BYTES: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Tab: '\t',
  'S-Tab': '\x1b[Z',
  PgUp: '\x1b[5~',
  PgDn: '\x1b[6~',
  'C-End': '\x1b[1;5F',
  // Claude Code's "send queued messages now" (Ctrl+X Ctrl+S; chat:sendNow, v2.1.275+)
  'C-X-C-S': '\x18\x13',
  ...Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => [d, d])),
};

/** Keys the UI may send to a session (`POST /api/sessions/:id/key`): only what drives Claude's TUI menus, nothing that could chord into something nasty. */
export const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'S-Tab', 'PgUp', 'PgDn', 'C-End', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

const locks = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attachAndType(shortId: string, chunks: string[]): Promise<void> {
  const bridge = ptyBridgeCommand(BRIDGE, 120, 40, ['claude', 'attach', shortId]);
  const child = spawn(bridge.cmd, bridge.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let bytes = 0;
  let last = Date.now();
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (d: Buffer) => {
    bytes += d.length;
    last = Date.now();
    // On attach, Claude asks what terminal this is and shows "Attaching…" until it gets an answer. A real
    // terminal replies by itself; here we must, or the attach can hang and nothing gets typed.
    const s = d.toString('latin1');
    if (/\x1b\[0?c/.test(s)) child.stdin.write('\x1b[?62;22c'); // DA1: a VT220 with ANSI colour
    if (s.includes('\x1b[6n')) child.stdin.write('\x1b[1;1R'); // cursor position report
  });
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('exit', () => (exited = true));

  try {
    // Wait for the TUI to draw and go quiet (up to 8s).
    const start = Date.now();
    while (!exited && Date.now() - start < 8_000 && (bytes === 0 || Date.now() - last < 700)) await sleep(100);
    if (exited || bytes === 0) throw new Error(`couldn't attach to ${shortId}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`);

    for (const chunk of chunks) {
      child.stdin.write(chunk);
      // Let each step land: longer text before Enter, and menu screens time to redraw between keys.
      await sleep(chunk.length > 1 && !chunk.startsWith('\x1b') ? 400 : 350);
    }
    await sleep(1_000); // let the job take the input before we detach
  } finally {
    // Closing stdin makes the bridge hang up its child (a clean detach); kill if it lingers.
    child.stdin.end();
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    if (!exited) child.kill('SIGTERM');
  }
}

/** Type text (optionally submitting it) or press keys in a background job. Serialised per job. */
export function typeIntoJob(shortId: string, input: { text?: string; submit?: boolean; key?: string }): Promise<void> {
  const chunks: string[] = [];
  if (input.text) {
    chunks.push(input.text);
    if (input.submit !== false) chunks.push('\r');
  }
  if (input.key) {
    const bytes = KEY_BYTES[input.key];
    if (!bytes) return Promise.reject(new Error(`key not allowed: ${input.key}`));
    chunks.push(bytes);
  }
  const prev = locks.get(shortId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => attachAndType(shortId, chunks));
  locks.set(shortId, next.finally(() => locks.get(shortId) === next && locks.delete(shortId)).catch(() => {}));
  return next;
}

/** Type a prepared sequence of chunks (text and key bytes) in one attach. Serialised per job. */
export function typeSequence(shortId: string, chunks: string[]): Promise<void> {
  const prev = locks.get(shortId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => attachAndType(shortId, chunks));
  locks.set(shortId, next.finally(() => locks.get(shortId) === next && locks.delete(shortId)).catch(() => {}));
  return next;
}
