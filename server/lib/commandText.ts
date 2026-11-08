/** Longest command the app will type into a session or terminal. */
export const MAX_COMMAND_LENGTH = 2_000;

/**
 * Why a command can't be typed into a Claude prompt or a terminal, or null if it's fine: it must be one non-empty line
 * (no control characters: a newline would submit early) of at most 2000 characters. Shared by a session's Run
 * (command-runs) and "▶ Terminal" (terminals) through plugin-api/server.ts.
 */
export function invalidCommand(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'command required';
  if (command.length > MAX_COMMAND_LENGTH) return 'command too long';
  if (/[\x00-\x1f\x7f]/.test(command.trim())) return 'command must be a single line';
  return null;
}
