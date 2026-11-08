import type { HistoryEntry, TranscriptEnricher } from '../../../plugin-api/server.ts';
import { commandCandidates } from './shared/scriptPath.ts';

/**
 * `!` runs in the transcript (the `shell` field on history entries): a `!` command you ran in bash mode is recorded as two
 * user turns, `<bash-input>cmd</bash-input>`, then `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`; the
 * enricher turns them into one user entry with `shell: { command, output, stderr }`. Entries carry SHELL_CAP of the
 * output; the full output (up to SHELL_FULL_CAP) stays in the enricher's state for `shellOutputs().at` / `.since`.
 */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const SHELL_ID = 'shell';
const SHELL_CAP = 6000;
const SHELL_FULL_CAP = 512_000;
const tagText = (t: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(t)?.[1];
const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

export interface ShellState {
  /** `!` runs' full output (up to SHELL_FULL_CAP; entries only carry SHELL_CAP): entry index → output. */
  full: Map<number, string>;
}

/** The core's cached transcript of a session: its entries and an enricher's state (`ctx.sessions.transcriptState`). */
export type TranscriptStateFn = (sessionId: string) => Promise<{ entries: HistoryEntry[]; state<S>(enricherId: string): S | undefined } | null>;

/** One `<bash-…>` user turn → a new entry or the output of the run just before. True if handled. */
function shellTurn(entries: HistoryEntry[], push: (e: HistoryEntry) => void, full: Map<number, string>, text: string, at: string | null): boolean {
  const input = tagText(text, 'bash-input');
  if (input !== undefined) {
    const command = input.trim();
    push({ i: entries.length, at, kind: 'user', text: `! ${command}`, shell: { command } });
    return true;
  }
  const out = tagText(text, 'bash-stdout');
  const err = tagText(text, 'bash-stderr');
  if (out === undefined && err === undefined) return false;
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - 5; i--) {
    const sh = entries[i].shell;
    if (!sh) continue;
    if (sh.output === undefined) {
      const stdout = stripAnsi(out ?? '').trimEnd();
      const stderr = stripAnsi(err ?? '').trimEnd();
      const all = [stdout, stderr].filter(Boolean).join('\n');
      sh.output = clip(all, SHELL_CAP);
      sh.stderr = !!stderr;
      if (all.length > SHELL_CAP) full.set(i, clip(all, SHELL_FULL_CAP));
    }
    break;
  }
  return true;
}

export const shellEnricher: TranscriptEnricher<ShellState> = {
  id: SHELL_ID,
  init: () => ({ full: new Map() }),
  onRecord(rec, h) {
    if (!isObj(rec) || rec.isSidechain || rec.type !== 'user' || rec.isMeta) return;
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string') return shellTurn(h.entries, h.push, h.state.full, content, h.at);
    // Mixed content: the shell text blocks become entries here; the core skips them as harness noise (`<bash-…`).
    for (const b of Array.isArray(content) ? content : []) {
      if (isObj(b) && b.type === 'text' && typeof b.text === 'string') shellTurn(h.entries, h.push, h.state.full, b.text, h.at);
    }
  },
};

/**
 * Has `command` already run in this conversation, by your `!` or by Claude's own Bash tool? A `!` run matches on the
 * exact command. A Bash call (its summary is clipped, so only the start of the command is visible) matches when it
 * finished without error and names the command's script file, which is how Claude runs the scripts it writes for you.
 */
export function ranInEntries(entries: HistoryEntry[], command: string): boolean {
  const script = commandCandidates(command).find((c) => /\.\w+$/.test(c))?.split('/').pop();
  return entries.some((e) => {
    if (e.shell) return e.shell.command === command && e.shell.output !== undefined;
    if (e.tool !== 'Bash' || !e.doneAt || e.isError || !e.summary) return false;
    return e.summary.includes(command) || (!!script && e.summary.includes(script));
  });
}

export function shellOutputs(transcriptState: TranscriptStateFn) {
  return {
    /** A `!` run's full output by its entry index (null if that entry isn't a finished `!` run). */
    async at(sessionId: string, i: number): Promise<{ command: string; output: string; stderr: boolean; at: string | null } | null> {
      const t = await transcriptState(sessionId);
      const e = t?.entries[i];
      if (!t || !e?.shell || e.shell.output === undefined) return null;
      return { command: e.shell.command, output: t.state<ShellState>(SHELL_ID)?.full.get(i) ?? e.shell.output, stderr: !!e.shell.stderr, at: e.at };
    },
    /** Has `command` already run in the session (see `ranInEntries`)? */
    async ran(sessionId: string, command: string): Promise<boolean> {
      const t = await transcriptState(sessionId);
      return !!t && ranInEntries(t.entries, command);
    },
    /** The latest finished `!` run of `command` at or after `sinceMs`, with its full output (else null). */
    async since(sessionId: string, command: string, sinceMs: number): Promise<{ output: string; stderr: boolean; at: string | null } | null> {
      const t = await transcriptState(sessionId);
      if (!t) return null;
      const full = t.state<ShellState>(SHELL_ID)?.full;
      for (let i = t.entries.length - 1; i >= 0; i--) {
        const e = t.entries[i];
        if (e.at && Date.parse(e.at) < sinceMs) break;
        if (e.shell?.command === command && e.shell.output !== undefined) return { output: full?.get(i) ?? e.shell.output, stderr: !!e.shell.stderr, at: e.at };
      }
      return null;
    },
  };
}
