import type { HistoryEntry, Session } from '../../../plugin-api/server.ts';
import type { CommandRun, RunStore } from './commandRuns.ts';

/**
 * Run a command in a background session's own shell, as if you'd typed `! <command>` at its prompt: Claude Code
 * runs it in bash mode and records the command and its output in the conversation; in a background job that
 * also starts a turn, so Claude reads the output.
 *
 * Every Run is a row in `command_runs` (commandRuns.ts), so the queue and the record of what ran don't
 * depend on the page that asked: bash mode only works at an idle prompt, so while Claude is working or a menu is up
 * the row stays "queued" and a poller types it once the session has been idle for two checks in a row. Pollers are
 * restarted for queued rows when the server starts. A row queued longer than QUEUE_MS expires.
 * Once a typed-in run's output lands in the transcript it's copied onto the row (captureOutput), so the result is
 * kept with the run.
 */

const POLL_MS = 3_000; // waiting for a run's output to land in the transcript
const QUEUE_POLL_MS = 1_000; // waiting for the session to be at its prompt
const QUEUE_MS = 2 * 60 * 60_000;
const OUTPUT_WAIT_MS = 60 * 60_000;

type Lookup = (id: string) => Promise<Session | undefined>;

export type RunResult = { status: 'ran' } | { status: 'queued' };

export interface RunQueueDeps {
  store: RunStore;
  typeSequence(shortId: string, parts: string[]): Promise<void>;
  KEY_BYTES: Record<string, string>;
  /** The session's unanswered AskUserQuestion, if any (a form is up: keys would answer it). */
  openQuestion(sessionId: string): Promise<HistoryEntry | null>;
  shellOutputSince(sessionId: string, command: string, sinceMs: number): Promise<{ output: string; stderr: boolean; at: string | null } | null>;
  /** Has the command already run in the session's conversation (by `!` or Claude's Bash tool)? */
  alreadyRan(sessionId: string, command: string): Promise<boolean>;
  log(msg: string): void;
  logError(msg: string, err: unknown): void;
}


export function runQueue(deps: RunQueueDeps) {
  const { store } = deps;
  const pollers = new Set<string>();

  /**
   * At Claude's prompt, where "!" starts bash mode. Goes by the process's own idle/waiting/busy (`promptState`), not the
   * job state: a turn that ended by asking you to do something leaves the job "blocked" while it sits at its prompt,
   * whereas "waiting" means a menu is up (a permission prompt or question), where the keys would pick an option.
   */
  async function ready(s: Session): Promise<boolean> {
    // Not s.status: that comes from the job's state.json, which can stay "working" after a turn has ended.
    if (s.promptState !== 'idle') return false;
    return !(await deps.openQuestion(s.sessionId));
  }

  /** Why the queue is waiting, logged when it changes, so a stuck queue explains itself. */
  const lastWhy = new Map<string, string>();
  function logWhy(s: Session, isReady: boolean): void {
    const why = `ready=${isReady} promptState=${s.promptState} status=${s.status} raw=${s.rawStatus}`;
    if (lastWhy.get(s.sessionId) === why) return;
    lastWhy.set(s.sessionId, why);
    deps.log(`[run-queue] ${s.shortId}: ${why}`);
  }

  function type(s: Session, command: string): Promise<void> {
    // "!" switches the prompt to bash mode; it has to arrive on its own before the command.
    return deps.typeSequence(s.shortId, ['!', command, deps.KEY_BYTES.Enter ?? '\r']);
  }

  async function typeRun(s: Session, run: CommandRun): Promise<void> {
    try {
      const typedAt = Date.now() - 2_000; // transcript timestamps vs our clock: a little slack
      await type(s, run.command);
      store.finishRun(run.id, 'ran');
      void captureOutput(run.sessionId, run.id, run.command, typedAt);
    } catch (err) {
      store.finishRun(run.id, 'failed', (err as Error).message);
      throw err;
    }
  }

  async function runCommand(s: Session, command: string, lookup: Lookup): Promise<RunResult> {
    if (s.kind !== 'background') throw new Error('interactive sessions can only run commands in their own terminal');
    const cmd = command.trim();
    const ahead = store.queuedRuns(s.sessionId).filter((r) => r.command !== cmd);
    const run = store.enqueueRun(s.sessionId, cmd);
    if (!ahead.length && !pollers.has(s.sessionId) && (await ready(s))) {
      await typeRun(s, run);
      return { status: 'ran' };
    }
    void poll(s.sessionId, lookup);
    return { status: 'queued' };
  }

  function cancelCommand(sessionId: string, command: string): boolean {
    return store.cancelRun(sessionId, command.trim());
  }

  /** The latest Run of each command in the session (queued, ran, failed…), for the cards. */
  function commandRuns(sessionId: string): CommandRun[] {
    return store.latestRuns(sessionId);
  }

  /** Copy a run's output from the transcript onto its row once it lands (gives up after OUTPUT_WAIT_MS). */
  async function captureOutput(sessionId: string, id: number, command: string, since: number): Promise<void> {
    const until = since + OUTPUT_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const out = await deps.shellOutputSince(sessionId, command, since);
      if (!out) continue;
      store.recordOutput(id, out.output, out.stderr, out.at);
      return;
    }
  }

  /** After a restart: pick the queues back up, and keep waiting for outputs of runs typed in before it. */
  function resumeQueues(lookup: Lookup): void {
    for (const id of store.sessionsWithQueued()) void poll(id, lookup);
    for (const r of store.runsAwaitingOutput(OUTPUT_WAIT_MS)) void captureOutput(r.sessionId, r.id, r.command, Date.parse(r.doneAt!) - 5_000);
  }

  async function poll(sessionId: string, lookup: Lookup): Promise<void> {
    if (pollers.has(sessionId)) return;
    pollers.add(sessionId);
    try {
      let idleChecks = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
        let q = store.queuedRuns(sessionId);
        for (const r of q) if (Date.now() - Date.parse(r.queuedAt) > QUEUE_MS) store.finishRun(r.id, 'expired');
        // A command that has since run in the conversation (Claude ran its own script, say) has nothing left to wait for.
        for (const r of q) if (await deps.alreadyRan(sessionId, r.command).catch(() => false)) store.finishRun(r.id, 'failed', 'already ran in this session');
        q = store.queuedRuns(sessionId);
        if (!q.length) return;
        const s = await lookup(sessionId);
        if (!s || s.kind !== 'background' || (['done', 'failed', 'stopped'].includes(s.status) && !s.pid)) {
          for (const r of q) store.finishRun(r.id, 'failed', 'the session is no longer running');
          return;
        }
        const isReady = await ready(s);
        logWhy(s, isReady);
        idleChecks = isReady ? idleChecks + 1 : 0;
        if (idleChecks < 2) continue;
        await typeRun(s, q[0]!).catch((err) => deps.logError(`queued command for ${sessionId} failed:`, err));
        idleChecks = 0; // let the command finish (and its output land) before typing the next one
      }
    } finally {
      pollers.delete(sessionId);
    }
  }

  return { runCommand, cancelCommand, commandRuns, resumeQueues };
}
