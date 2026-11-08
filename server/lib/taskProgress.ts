import { open, stat } from 'node:fs/promises';
import { summarise, type BackgroundTaskInfo } from './transcript.ts';

/** How far a running background task has got, read from its output file. */
export interface TaskProgress {
  /** When it last wrote output (ms). */
  lastOutputAt?: number;
  /** Shells: the output's size and its last few lines (ANSI stripped). */
  bytes?: number;
  lines?: string[];
  /** Agents: tool calls made so far and the latest thing it did (a tool call or a line of its text). */
  steps?: number;
  /** Agents: its transcript was longer than what was read, so `steps` only counts the latest of them. */
  more?: boolean;
  last?: string;
}

const SHELL_TAIL = 4096;
const AGENT_TAIL = 512 * 1024;
const LINES = 4;
const LINE_MAX = 200;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '');

async function readTail(path: string, size: number, n: number): Promise<{ text: string; cut: boolean }> {
  const len = Math.min(size, n);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return { text: buf.toString('utf8'), cut: len < size };
  } finally {
    await fh.close();
  }
}

/** The last lines of a shell task's output. */
export function shellProgress(text: string, cut: boolean): Pick<TaskProgress, 'lines'> {
  const all = stripAnsi(text).split('\n');
  if (cut) all.shift(); // probably a partial line
  const lines = all.map((l) => l.trimEnd()).filter((l) => l.trim());
  return { lines: lines.slice(-LINES).map((l) => clip(l, LINE_MAX)) };
}

/** An agent's steps and latest action, from the tail of its transcript (steps are counted in what was read). */
export function agentProgress(text: string, cut: boolean): Pick<TaskProgress, 'steps' | 'more' | 'last'> {
  const lines = text.split('\n');
  if (cut) lines.shift();
  let steps = 0;
  let last: string | undefined;
  for (const l of lines) {
    if (!l.includes('"type":"assistant"')) continue;
    let r: { type?: string; message?: { content?: unknown } };
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        steps++;
        last = clip(`${b.name}: ${summarise(b.name, (b.input ?? {}) as Record<string, unknown>)}`, LINE_MAX);
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        last = clip(b.text.trim().split('\n')[0]!, LINE_MAX);
      }
    }
  }
  return { steps, ...(cut ? { more: true } : {}), ...(last ? { last } : {}) };
}

/** A running task's progress, or null when its output file is unknown or unreadable. Only reads `.output` files. */
export async function taskProgress(kind: string, info: BackgroundTaskInfo | undefined): Promise<TaskProgress | null> {
  const path = info?.outputFile;
  if (!path || !path.endsWith('.output')) return null;
  try {
    const st = await stat(path);
    const base = { lastOutputAt: st.size ? Math.round(st.mtimeMs) : undefined };
    if (kind === 'agent') {
      const { text, cut } = await readTail(path, st.size, AGENT_TAIL);
      return { ...base, ...agentProgress(text, cut) };
    }
    const { text, cut } = await readTail(path, st.size, SHELL_TAIL);
    return { ...base, bytes: st.size, ...shellProgress(text, cut) };
  } catch {
    return null;
  }
}
