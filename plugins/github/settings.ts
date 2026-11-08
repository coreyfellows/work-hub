import type { ServerPluginContext } from '../../plugin-api/server.ts';

/** What the plugin's server files read at call time; `server.ts` sets it once in `register()`. */
export interface GithubSettings {
  ctx: ServerPluginContext;
  /** The GitHub host every `gh` call goes to, resolved lazily (`hostResolver` in ghHost.ts). */
  host(): Promise<string>;
  /** Working dir for `gh` runs (the app's cache dir). */
  scratch: string;
  /** My merged PRs stay listed (under Merged) for this many days. */
  mergedDays: number;
  /** PR "Start session": the model for my own PR, and for reviewing someone else's. */
  modelMine: string;
  modelReview: string;
  /** Jira base URL, for the ticket link a PR session's workspace gets (empty: no link). Read on use. */
  jiraBaseUrl: string;
}

let current: GithubSettings | null = null;

export function setSettings(s: GithubSettings): void {
  current = s;
}

export function settings(): GithubSettings {
  if (!current) throw new Error('the github plugin is not registered');
  return current;
}
