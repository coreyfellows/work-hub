import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.ts';
import { runJson } from '../lib/exec.ts';
import { branchInfo } from '../lib/git.ts';
import { backgroundTasks, lastActivity, openQuestion } from '../lib/transcript.ts';
import { backgroundStatus, backgroundWork, runningTasks, waitingOnTasks, type FanTask, type InFlight, type RunningTask } from '../lib/sessionStatus.ts';
import { markFirstSeen, seenTimes } from '../store/sessionReads.ts';
import { sessionNames } from '../store/sessionNames.ts';
import type { Source } from '../registry.ts';

/**
 * Claude sessions from `claude agents`. Background jobs (everything work-hub starts) are fully
 * visible and drivable: state and questions from ~/.claude/jobs/<id>/state.json, screen from
 * `claude logs`, input via a pty attach. Interactive sessions (plain `claude` in some terminal) are
 * reachable only through that terminal, so they're shown with busy/idle status only.
 */

export interface Session {
  sessionId: string;
  shortId: string;
  name: string;
  cwd: string;
  kind: 'interactive' | 'background';
  /** Normalised: working | idle | needs-input | done | failed | stopped | unknown */
  status: string;
  rawStatus: string | null;
  /**
   * What `claude agents` says the process is doing: idle (at its prompt), waiting (a menu or question is on screen),
   * busy. A background job whose turn ended by asking you something is state "blocked" yet idle here.
   */
  promptState: string | null;
  /** What a waiting session is waiting for, from `claude agents` (e.g. "permission prompt"); null otherwise. */
  waitingFor: string | null;
  needsInput: boolean;
  /** Background jobs: subagents, background shells and monitors still running (the job carries on when they finish). */
  background: number;
  /** Background jobs: Claude's turn has ended and only its background tasks keep it working ("waiting on task"). */
  waitingOnTasks: boolean;
  /** Background jobs: the background tasks still running (mid-turn too), each with a short description (empty otherwise). */
  tasks: RunningTask[];
  /** It has said something (an assistant message) since you last looked at it (POST /api/sessions/:id/seen). */
  unread: boolean;
  /** The unanswered AskUserQuestion's transcript entry id, so a new question right after an answer is noticed. */
  questionId: string | null;
  /** Background jobs: the current question or final result. */
  detail: string | null;
  intent: string | null;
  startedAt: number;
  /** Timestamp of the last assistant message in the transcript (ms): for an idle session, when it finished its turn. */
  lastActiveAt: number | null;
  /** OS process id while the session is running (from `claude agents`). */
  pid: number | null;
  /** git branch and origin repo (owner/name) of the session's cwd, used to link PRs */
  branch: string | null;
  repo: string | null;
}

export interface ClaudeData {
  sessions: Session[];
}

interface AgentJson {
  id?: string;
  pid?: number;
  cwd: string;
  kind: 'interactive' | 'background';
  startedAt: number;
  sessionId: string;
  name?: string;
  status?: string;
  state?: string;
  waitingFor?: string;
}

interface JobStateJson {
  state?: string;
  tempo?: string;
  inFlight?: InFlight;
  fan?: FanTask[];
  updatedAt?: string;
  detail?: string;
  intent?: string;
  name?: string;
  output?: { result?: string } | null;
}

const JOBS_DIR = join(homedir(), '.claude', 'jobs');

/** A session `claude agents` lists; return true to hide it (e.g. a plugin's own headless runs). */
export type HidePredicate = (s: { sessionId?: string; name?: string | null; cwd: string }) => boolean;

const hidePredicates: Array<{ fn: HidePredicate; owner: string }> = [];

/** Hide the sessions `pred` matches from everything (the sessions list, reconcile). `owner`: for `removeHidePredicates`. */
export function hideSession(pred: HidePredicate, owner = 'core'): void {
  hidePredicates.push({ fn: pred, owner });
}

/** Drop every predicate `owner` added. */
export function removeHidePredicates(owner: string): void {
  for (let i = hidePredicates.length - 1; i >= 0; i--) if (hidePredicates[i].owner === owner) hidePredicates.splice(i, 1);
}

function hidden(a: { sessionId: string; name?: string | null; cwd: string }): boolean {
  return hidePredicates.some(({ fn, owner }) => {
    try {
      return fn({ sessionId: a.sessionId, name: a.name ?? null, cwd: a.cwd });
    } catch (e) {
      console.error(`hide predicate (${owner}):`, e);
      return false;
    }
  });
}

async function readJobState(shortId: string): Promise<JobStateJson | null> {
  try {
    return JSON.parse(await readFile(join(JOBS_DIR, shortId, 'state.json'), 'utf8')) as JobStateJson;
  } catch {
    return null;
  }
}

async function fetchSessions(): Promise<ClaudeData> {
  const agents = await runJson<AgentJson[]>('claude', ['agents', '--json', '--all'], { timeoutMs: 10_000 });
  const now = Date.now();

  const sessions = await Promise.all(
    agents.map(async (a): Promise<Session | null> => {
      if (a.cwd.startsWith(config.paths.scratch)) return null; // our own headless runs (e.g. MCP checks)
      if (hidden(a)) return null; // e.g. adversarial-review reviewers: they run in a recorded worktree, so they'd be adopted into the workspace
      const shortId = a.id ?? a.sessionId.slice(0, 8);
      const git = await branchInfo(a.cwd);
      const lastActiveAt = await lastActivity(a.sessionId);
      const base = { sessionId: a.sessionId, shortId, cwd: a.cwd, startedAt: a.startedAt, lastActiveAt, pid: a.pid ?? null, ...git };
      // A question form (AskUserQuestion) on screen doesn't change the job's state, so check the transcript.
      const question = a.pid ? await openQuestion(a.sessionId) : null;
      const asking = !!question;
      const questionId = question?.id ?? null;

      if (a.kind === 'background') {
        const job = await readJobState(shortId);
        const raw = job?.state ?? a.state ?? null;
        const alive = typeof a.pid === 'number';
        const signals = {
          alive,
          agentStatus: a.status ?? null,
          tempo: job?.tempo ?? null,
          jobState: raw,
          inFlight: job?.inFlight ?? null,
          asking,
          stateAt: job?.updatedAt ? Date.parse(job.updatedAt) : null,
          lastActiveAt,
        };
        const status = backgroundStatus(signals);
        const waiting = waitingOnTasks({ ...signals, status });
        // Any background work running: its tasks (the transcript is already loaded for openQuestion).
        const tasks = alive && backgroundWork(job?.inFlight) > 0 ? runningTasks(job?.fan, await backgroundTasks(a.sessionId)) : [];
        if ((status === 'done' || status === 'failed' || status === 'stopped') && now - a.startedAt > config.claude.recentDoneMs) {
          return null;
        }
        return {
          ...base,
          name: a.name ?? job?.name ?? shortId,
          kind: 'background',
          status,
          rawStatus: raw,
          promptState: a.status ?? null,
          waitingFor: a.status === 'waiting' ? (a.waitingFor ?? null) : null,
          needsInput: status === 'needs-input',
          background: alive ? backgroundWork(job?.inFlight) : 0,
          waitingOnTasks: waiting,
          tasks,
          unread: false,
          questionId,
          detail: job?.output?.result ?? job?.detail ?? null,
          intent: job?.intent ?? null,
        };
      }

      // Interactive: Claude only reports busy/idle, but its transcript shows an unanswered question.
      return {
        ...base,
        name: a.name ?? shortId,
        kind: 'interactive',
        status: a.status === 'busy' ? 'working' : asking || a.status === 'waiting' ? 'needs-input' : (a.status ?? 'unknown'),
        rawStatus: a.status ?? null,
        promptState: a.status ?? null,
        waitingFor: a.status === 'waiting' ? (a.waitingFor ?? null) : null,
        needsInput: a.status !== 'busy' && (asking || a.status === 'waiting'),
        background: 0,
        waitingOnTasks: false,
        tasks: [],
        unread: false,
        questionId,
        detail: null,
        intent: null,
      };
    }),
  );

  const list = sessions.filter((s): s is Session => s !== null);
  applyNames(list);
  markUnread(list, now);
  const rank = (s: Session) => (s.needsInput ? 0 : s.status === 'working' ? 1 : s.status === 'idle' ? 2 : 3);
  list.sort((x, y) => rank(x) - rank(y) || y.startedAt - x.startedAt);
  return { sessions: list };
}

const serverStartedAt = Date.now();

/** Names you gave sessions in the app win over the one Claude reports. */
function applyNames(list: Session[]): void {
  try {
    const names = sessionNames();
    for (const s of list) s.name = names.get(s.sessionId) ?? s.name;
  } catch {
    // The DB is a nicety here; sessions still list without it.
  }
}

/** Sets `unread`: the last assistant message is newer than when you last looked (first sighting counts as a look). */
function markUnread(list: Session[], now: number): void {
  try {
    let seen = seenTimes();
    const first = list.filter((s) => !seen.has(s.sessionId)).map((s): [string, number] => [s.sessionId, s.startedAt >= serverStartedAt ? s.startedAt : now]);
    if (first.length) {
      markFirstSeen(first);
      seen = seenTimes();
    }
    for (const s of list) s.unread = s.lastActiveAt != null && s.lastActiveAt > (seen.get(s.sessionId) ?? now);
  } catch {
    // The DB is a nicety here; sessions still list without it.
  }
}

export const claudeSource: Source<ClaudeData> = {
  id: 'claude',
  title: 'Claude sessions',
  intervalMs: config.claude.intervalMs,
  local: true,
  fetch: fetchSessions,
};
