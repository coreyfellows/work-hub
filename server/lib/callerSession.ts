import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Which Claude session is running `wh` (or any other process a session spawns), from its environment: every Bash call a
 * session makes carries `CLAUDE_CODE_SESSION_ID` (the full session UUID) and, in a background job, `CLAUDE_JOB_DIR`
 * (`~/.claude/jobs/<job id>`; the job id is not the UUID, state.json's `sessionId` is). A subagent has its own
 * `CLAUDE_CODE_SESSION_ID`, which no workspace knows, plus `CLAUDE_CODE_CHILD_SESSION`: there the job wins.
 */
export function callerSessionId(env: NodeJS.ProcessEnv, readJobSessionId: (jobId: string) => string | null, explicit?: string): string | null {
  if (explicit) return explicit;
  const jobId = env.CLAUDE_JOB_DIR ? basename(env.CLAUDE_JOB_DIR) : null;
  const fromJob = () => (jobId ? readJobSessionId(jobId) : null);
  if (env.CLAUDE_CODE_CHILD_SESSION) {
    const id = fromJob();
    if (id) return id;
  }
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  return fromJob();
}

/** A job's session UUID from `<jobsDir>/<jobId>/state.json`, or null (no retry: the job has been running a while by the time it runs `wh`). */
export function readJobSessionIdSync(jobId: string, jobsDir = join(homedir(), '.claude', 'jobs')): string | null {
  try {
    const st = JSON.parse(readFileSync(join(jobsDir, jobId, 'state.json'), 'utf8')) as { sessionId?: unknown };
    return typeof st.sessionId === 'string' && st.sessionId ? st.sessionId : null;
  } catch {
    return null;
  }
}
