/** Shapes shared by the server and web halves (types only). */
import type { ChangelogEntry } from './changelog.ts';
import type { Analysis } from './suggest.ts';

export const SOURCE_ID = 'claude-monitor';
export const API = '/api/plugins/claude-monitor';
export const UPDATE_JOB = 'claude-update';
export const ANALYZE_JOB = 'claude-monitor-analyze';
export const APPLY_JOB = 'claude-monitor-apply';

/** The `claude-monitor` source: small, rides the SSE stream. */
export interface MonitorData {
  /** `claude --version`, or null when it can't be run. */
  installed: string | null;
  /** The channel's newest version on npm, or null before the first successful check. */
  latest: string | null;
  channel: 'latest' | 'stable';
  updateAvailable: boolean;
  /** The newest version whose What's new the user has seen (closed the modal on). */
  acknowledged: string | null;
  /** The installed version is newer than `acknowledged`: show What's new. */
  whatsNew: boolean;
  /** When npm was last asked (ms), and why it failed if it did. */
  checkedAt: number | null;
  checkError: string | null;
  /** A `claude update` job is running. */
  updating: boolean;
  analysis: { status: 'none' | 'running' | 'done' | 'failed'; version: string | null; count: number; error: string | null };
}

export interface WhatsNew {
  from: string | null;
  to: string | null;
  installed: string | null;
  latest: string | null;
  entries: ChangelogEntry[];
  /** Where the changelog came from: the cached GitHub copy, or Claude Code's own cache. */
  changelog: 'remote' | 'local' | null;
  error: string | null;
}

export interface PluginRow {
  id: string;
  title: string;
  kind: 'official' | 'local';
  manifestVersion: string | null;
  record: { version: string; action: string; workspaceId: string | null; at: string } | null;
  baseline: string | null;
}

export type { Analysis };
