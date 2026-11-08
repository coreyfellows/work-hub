import type { ServerPluginContext } from '../../plugin-api/server.ts';

/** What the plugin's server files share: the context and its settings, set once by `register()` (server.ts). */
export interface SessionToolsSettings {
  ctx: ServerPluginContext;
  /** Default model for sessions started by hand (and when "auto" can't pick). */
  sessionModel: string;
  /** The model that rates a task for "auto" (sessionPlan.ts), and how long it may take. */
  plannerModel: string;
  plannerTimeoutMs: number;
  /** Where handoff briefs are saved. */
  handoffDir: string;
  /** How long the headless fork writing a handoff brief may take. */
  summaryTimeoutMs: number;
}

let current: SessionToolsSettings | null = null;

export function setSettings(s: SessionToolsSettings): void {
  current = s;
}

export function settings(): SessionToolsSettings {
  if (!current) throw new Error('session-tools: settings used before register()');
  return current;
}
