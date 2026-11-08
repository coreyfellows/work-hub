/**
 * A background job's status from its signals, most live first. What each one means (from the Claude CLI):
 *
 * - `agentStatus` (`claude agents`): the process right now. busy = a turn is running; waiting = a menu or question
 *   form is on screen; idle = at its prompt.
 * - `tempo` (state.json): also mechanical. active = a turn is running.
 * - `inFlight` (state.json): background work the job started (subagents, background shells, monitors, queued
 *   messages). When it finishes, the job wakes itself up and carries on, so it's still working, not waiting on you.
 *   A pending scheduled wakeup (`session_cron`) alone is not: the job is idle until it fires.
 * - `jobState` (state.json): an LLM's summary of the last message (working/blocked/done/failed), written after a
 *   turn ends. It lags: it stays "blocked" for the whole of the next turn after you answer. `stateAt` (state.json
 *   updatedAt) older than `lastActiveAt` (the last assistant message) means it hasn't caught up with that turn yet.
 *
 * "Waiting on you" when no turn is running and a question or menu is open (even with background work in flight: your
 * answer comes first), or when nothing at all is running and the last turn ended asking you something.
 */

export interface InFlight {
  tasks?: number;
  queued?: number;
  kinds?: string[];
  drainableMonitors?: number;
}

export interface BackgroundSignals {
  alive: boolean;
  agentStatus: string | null;
  tempo: string | null;
  jobState: string | null;
  inFlight: InFlight | null;
  /** An unanswered AskUserQuestion in the transcript. */
  asking: boolean;
  stateAt: number | null;
  lastActiveAt: number | null;
}

/**
 * Background work still running (subagents, shells, monitors, queued messages). A scheduled wakeup or /loop timer
 * (`session_cron`) isn't work: the job is asleep until it fires (a ScheduleWakeup fallback can sit there long after
 * the work it guarded finished), so it's left out. `kinds` is a set, not one per task: when it's only crons, every
 * task is one; mixed, at least one task is real work.
 */
export function backgroundWork(f: InFlight | null | undefined): number {
  if (!f) return 0;
  let tasks = Math.max(0, (f.tasks ?? 0) - (f.drainableMonitors ?? 0));
  const kinds = f.kinds ?? [];
  if (tasks > 0 && kinds.includes('session_cron')) {
    tasks = kinds.some((k) => k !== 'session_cron') ? Math.max(1, tasks - 1) : 0;
  }
  return tasks + (f.queued ?? 0);
}

export function backgroundStatus(s: BackgroundSignals): string {
  // No process (exited, or being respawned): the job record is all there is.
  if (!s.alive) {
    switch (s.jobState) {
      case 'working':
        return 'working';
      case 'blocked':
        return 'needs-input';
      case 'failed':
      case 'error':
        return 'failed';
      case 'stopped':
        return 'stopped';
      case 'done':
        return 'done';
      default:
        return s.jobState ?? 'unknown';
    }
  }
  if (s.agentStatus === 'busy' || s.tempo === 'active') return 'working';
  // An open question or menu beats background work: the job can't use your answer until you give it.
  if (s.asking || s.agentStatus === 'waiting') return 'needs-input';
  if (backgroundWork(s.inFlight) > 0) return 'working';
  const fresh = s.stateAt == null || s.lastActiveAt == null || s.stateAt >= s.lastActiveAt;
  if (s.jobState === 'blocked' && fresh) return 'needs-input';
  if (s.jobState === 'failed' && fresh) return 'failed';
  return 'idle';
}

/** One entry of state.json's `fan`: what the job has going (subagents, shells, monitors, its todo list). */
export interface FanTask {
  id?: string;
  kind?: string;
  label?: string;
  startedAt?: number;
  doneAt?: number;
}

/** A background task still running, with a short description of what it's for. */
export interface RunningTask {
  /** state.json's task id (a shell's background task id, an agent's id). */
  id: string;
  kind: string;
  label: string;
  /** When it started (ms), if state.json says. */
  startedAt?: number;
}

const TASK_LABEL_MAX = 80;

/**
 * The background tasks still running (no `doneAt`; todo items aren't work), each described by the call that started
 * it when the transcript has one (`descs`: task id → the Bash call's `description`), else by its own label (a
 * subagent's is its description; a shell's is the command).
 */
export function runningTasks(fan: FanTask[] | null | undefined, descs?: Map<string, { description?: string }> | null): RunningTask[] {
  const out: RunningTask[] = [];
  for (const t of fan ?? []) {
    if (!t || t.doneAt || t.kind === 'todo') continue;
    const raw = (t.id && descs?.get(t.id)?.description) || t.label || t.kind || 'task';
    const label = raw.replace(/\s+/g, ' ').trim();
    out.push({
      id: t.id ?? '',
      kind: t.kind ?? 'task',
      label: label.length > TASK_LABEL_MAX ? `${label.slice(0, TASK_LABEL_MAX - 1)}…` : label,
      ...(typeof t.startedAt === 'number' && t.startedAt > 0 ? { startedAt: t.startedAt } : {}),
    });
  }
  return out;
}

/**
 * A working job whose own turn has ended, kept working only by its background tasks (it carries on when they finish).
 * `tempo` says whether a turn is running; `claude agents` reports `busy` either way while tasks run, so it only counts
 * when there's no tempo.
 */
export function waitingOnTasks(s: Pick<BackgroundSignals, 'alive' | 'agentStatus' | 'tempo' | 'inFlight'> & { status: string }): boolean {
  if (s.status !== 'working' || !s.alive || backgroundWork(s.inFlight) === 0) return false;
  return s.tempo ? s.tempo !== 'active' : s.agentStatus !== 'busy';
}
