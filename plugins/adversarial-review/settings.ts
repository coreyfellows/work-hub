import type { ServerPluginContext } from '../../plugin-api/server.ts';

/** What the plugin's server files read at call time; `server.ts` sets it once in `register()`. */
export interface ReviewSettings {
  ctx: ServerPluginContext;
  /** The model of the guided reviewer and of the session that addresses the findings. */
  model: string;
  /** Where reports are saved (the file viewer may open files there). */
  dir: string;
  /** The reviewers file (reviewers.ts; Claude fable/opus/sonnet when it doesn't exist). */
  reviewersFile: string;
}

let current: ReviewSettings | null = null;

export function setSettings(s: ReviewSettings): void {
  current = s;
}

export function settings(): ReviewSettings {
  if (!current) throw new Error('the adversarial-review plugin is not registered');
  return current;
}
