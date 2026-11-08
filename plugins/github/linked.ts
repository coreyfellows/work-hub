import type { Session } from '../../plugin-api/web.ts';
import type { PullRequest } from './types.ts';

/** Sessions and PRs are linked when the session's worktree has the PR's branch checked out. */
export function linked(s: Pick<Session, 'branch' | 'repo'>, p: Pick<PullRequest, 'branch' | 'repo'>): boolean {
  return !!s.branch && s.branch === p.branch && (!s.repo || s.repo.toLowerCase() === p.repo.toLowerCase());
}
