/**
 * Every headless call that uses an MCP server (`askClaudeJson` with `mcp`) opens its own session on that server, and
 * some servers cap the sessions per account ("too_many_sessions", 429) across everything the user runs (their own
 * Claude sessions included). So the app never has more than one of its own open per server at a time, and after a cap
 * error it stops asking that server for a while instead of making things worse.
 */

const CAP_RE = /too_many_sessions|session cap|\b429\b/i;

export function isSessionCapError(message: string): boolean {
  return CAP_RE.test(message);
}

export interface McpGate {
  /** Runs `fn` after earlier calls finish; throws at once (without running it) while cooling down. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Refuse new calls for `ms` (a cap error was seen). */
  coolDown(ms: number): void;
  /** Ms left of the cool-down, 0 when none. */
  coolingFor(): number;
}

export function createMcpGate(label = 'the MCP server', now: () => number = Date.now): McpGate {
  let tail: Promise<unknown> = Promise.resolve();
  let until = 0;
  const coolingFor = () => Math.max(0, until - now());
  return {
    coolingFor,
    coolDown(ms) {
      until = Math.max(until, now() + ms);
    },
    run(fn) {
      const next = tail.then(() => {
        const left = coolingFor();
        if (left > 0) throw new Error(`${label} has too many sessions open (429); not asking again for ${Math.ceil(left / 1000)}s`);
        return fn();
      });
      tail = next.catch(() => {});
      return next;
    },
  };
}

const gates = new Map<string, McpGate>();

/** The gate shared by every headless call to the MCP server named `name`. */
export function mcpGate(name: string): McpGate {
  let g = gates.get(name);
  if (!g) gates.set(name, (g = createMcpGate(name)));
  return g;
}

export const SESSION_CAP_COOLDOWN_MS = 2 * 60_000;
