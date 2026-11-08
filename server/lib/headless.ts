import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { run } from './exec.ts';
import { isSessionCapError, mcpGate, SESSION_CAP_COOLDOWN_MS } from './mcpGate.ts';

/**
 * Ask a headless `claude -p` run to do something and answer with JSON. With `mcp`, the run gets that one HTTP MCP
 * server's tools and nothing else (its OAuth lives in Claude Code): used for sources only reachable through an MCP
 * server. Without it the run has no tools. It costs tokens, so callers should keep prompts tight (name exact tools, cap
 * calls) and long intervals; the registry only runs sources while someone is watching.
 */

/** One HTTP MCP server for a headless run: `name` is how the prompt's tools are prefixed (`mcp__<name>__…`). */
export interface HeadlessMcp {
  name: string;
  url: string;
}

export interface HeadlessOptions {
  model: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** The MCP server whose tools the run may use. Absent: no tools at all. */
  mcp?: HeadlessMcp;
  /** Kept for older callers: the same as leaving `mcp` out. */
  tools?: 'none';
}

const mcpConfig = (m: HeadlessMcp) => JSON.stringify({ mcpServers: { [m.name]: { type: 'http', url: m.url } } });

export interface HeadlessResult<T> {
  value: T;
  costUsd: number | null;
  durationMs: number | null;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = trimmed.search(/[[{]/);
  return JSON.parse(start >= 0 ? trimmed.slice(start) : trimmed);
}

export async function askClaudeJson<T>(
  name: string,
  prompt: string,
  opts: HeadlessOptions,
): Promise<HeadlessResult<T>> {
  const mcp = opts.mcp;
  if (!mcp) return askOnce<T>(name, prompt, opts);
  // Each call is a session on that MCP server: one at a time per server, and a pause after it says there are too many (mcpGate.ts).
  const gate = mcpGate(mcp.name);
  return gate.run(async () => {
    try {
      return await askOnce<T>(name, prompt, opts);
    } catch (e) {
      if (isSessionCapError((e as Error).message)) gate.coolDown(SESSION_CAP_COOLDOWN_MS);
      throw e;
    }
  });
}

async function askOnce<T>(
  name: string,
  prompt: string,
  opts: HeadlessOptions,
): Promise<HeadlessResult<T>> {
  // A neutral dir (hidden from the sessions panel) so no project CLAUDE.md or hooks shape the answer.
  const cwd = join(config.paths.scratch, name);
  await mkdir(cwd, { recursive: true });
  const out = await run(
    'claude',
    [
      '-p', prompt,
      '--model', opts.model,
      '--output-format', 'json',
      '--no-session-persistence',
      ...(opts.mcp
        ? ['--strict-mcp-config', '--mcp-config', mcpConfig(opts.mcp), '--allowedTools', `mcp__${opts.mcp.name}`]
        : ['--strict-mcp-config', '--tools', '']),
      '--max-turns', String(opts.maxTurns ?? 10),
    ],
    { cwd, timeoutMs: opts.timeoutMs ?? 5 * 60_000 },
  );
  const envelope = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number };
  if (envelope.is_error || !envelope.result) throw new Error(`claude -p failed: ${envelope.result ?? 'no result'}`);
  const parsed = extractJson(envelope.result) as T | { error?: string };
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'error' in parsed && parsed.error) {
    throw new Error(opts.mcp ? `via ${opts.mcp.name}: ${parsed.error}` : parsed.error);
  }
  return { value: parsed as T, costUsd: envelope.total_cost_usd ?? null, durationMs: envelope.duration_ms ?? null };
}
