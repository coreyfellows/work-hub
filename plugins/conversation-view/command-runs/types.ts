/** Types both halves of the command-runs plugin use. */

export type CommandRunStatus = 'queued' | 'ran' | 'failed' | 'cancelled' | 'expired';

export interface CommandRun {
  id: number;
  sessionId: string;
  workspaceId: string | null;
  command: string;
  status: CommandRunStatus;
  queuedAt: string;
  doneAt: string | null;
  error: string | null;
  /** The run's result has been recorded (fetch it with runOutput): when it landed, its size, and if stderr had anything. */
  outputAt: string | null;
  outputLines: number | null;
  stderr: boolean;
  /** Where it ran: typed at the session's prompt (`!`), or in a new workspace terminal. */
  via: 'session' | 'terminal';
  /** Terminal runs: the script's exit code, once it has finished. */
  exitCode: number | null;
  termId: string | null;
}
