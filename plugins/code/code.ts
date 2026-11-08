import { readFile } from 'node:fs/promises';
import type { Workspace } from '../../plugin-api/server.ts';
import type { CodeLink } from './types.ts';

export type { CodeLink } from './types.ts';

export interface CodeOptions {
  /** Where VS Code serve-web is served, e.g. "/code" (its `--server-base-path`). */
  url: string;
  /** The file holding serve-web's connection token. */
  tokenFile: string;
}

/**
 * VS Code (serve-web) links for each of the workspace's worktrees. The access token stays server-side until a
 * signed-in work-hub user asks for these. No token (file missing or empty) = no links.
 */
export async function codeLinks(ws: Pick<Workspace, 'worktrees'>, opts: CodeOptions): Promise<CodeLink[]> {
  const token = (await readFile(opts.tokenFile, 'utf8').catch(() => '')).trim();
  if (!token) return [];
  return ws.worktrees.map((t) => ({
    label: `${t.repo.split('/')[1] ?? t.repo}${t.branch ? `@${t.branch}` : ''}`,
    path: t.path,
    url: `${opts.url}/?tkn=${encodeURIComponent(token)}&folder=${encodeURIComponent(t.path)}`,
  }));
}
