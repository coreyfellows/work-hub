import { useEffect, useState } from 'react';
import {
  Link,
  get,
  navigate,
  useLowData,
  type ClaudeData,
  type Issue,
  type PageProps,
  type Session,
  type Sources,
  type WebPluginContext,
  type Workspace,
  type Worktree,
} from '../../plugin-api/web.ts';
import { MarkdownLink } from './GithubFileLink.tsx';
import { PrPage } from './PrPage.tsx';
import { PrPanel } from './PrPanel.tsx';
import { PrsPage } from './PrsPage.tsx';
import { prChip } from './prChip.ts';
import type { GithubData, PullRequest } from './types.ts';
import './styles.css';

export type * from './types.ts';

const sessionsOf = (sources: Sources): Session[] => (sources.claude?.data as ClaudeData | null | undefined)?.sessions ?? [];
const githubOf = (sources: Sources) => (sources.github?.data as GithubData | null | undefined) ?? null;

/** The workspace's PRs (branch of one of its worktrees), oldest first. */
function workspacePrs(ws: Workspace, sources: Sources): PullRequest[] {
  const github = githubOf(sources);
  const all = [...(github?.mine ?? []), ...(github?.reviewRequested ?? []), ...(github?.merged ?? [])];
  return all
    .filter((p) => ws.worktrees.some((t) => isGitCopy(t) && t.branch === p.branch && t.repo?.toLowerCase() === p.repo.toLowerCase()))
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
}
/** PRs, chips and compare links are git's: a copy of another kind (or one with no repo) never matches. */
const isGitCopy = (t: Worktree): t is Worktree & { repo: string } => t.vcs === 'git' && !!t.repo;
const prFor = (prs: PullRequest[], t: Worktree) => !isGitCopy(t) ? undefined : prs.find((p) => p.branch === t.branch && p.repo.toLowerCase() === t.repo?.toLowerCase());

/**
 * Which worktrees' branches have something to put in a PR (by worktree id; false = nothing vs the base, so no
 * "Create PR"). The route is the worktree-diff plugin's, called by URL: without it nothing is known and the link shows.
 * Loaded on open and when the worktrees change; refreshed every 30s unless Low data is on.
 */
function usePrChanges(ws: Workspace): Record<number, boolean | null> {
  const lowData = useLowData();
  const [changes, setChanges] = useState<Record<number, boolean | null>>({});
  const key = ws.worktrees.map((t) => `${t.id}:${t.branch}:${t.baseBranch}`).join(',');
  useEffect(() => {
    let alive = true;
    const load = () =>
      get<Record<number, boolean | null>>(`/api/workspaces/${ws.id}/pr-changes`)
        .then((r) => alive && setChanges(r))
        .catch(() => {});
    void load();
    const timer = lowData ? null : setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [ws.id, key, lowData]);
  return changes;
}

/** GitHub's "open a pull request" page for a branch (against its recorded base when there is one). */
function createPrUrl(host: string, repo: string, branch: string, base: string | null): string {
  const range = base ? `${encodeURIComponent(base)}...${encodeURIComponent(branch)}` : encodeURIComponent(branch);
  return `https://${host}/${repo}/compare/${range}?expand=1`;
}

export default function register(ctx: WebPluginContext): void {
  // GitHub file links in any Markdown open the file in a modal (other links open in a new tab, as before).
  ctx.contribute('markdown-override', { tag: 'a', component: MarkdownLink });
  ctx.contribute('shortcut', { group: 'Pull requests', keys: ['Mod+Enter'], label: 'Send a comment or reply', where: 'in a comment box on a PR page' });
  ctx.contribute('page', {
    path: '/prs',
    nav: { label: 'PRs', badge: (s) => (githubOf(s)?.reviewRequested ?? []).filter((p) => !p.isDraft).length },
    component: ({ sources }: PageProps) => <PrsPage state={sources.github} sessions={sessionsOf(sources)} />,
  });
  ctx.contribute('page', {
    path: '/prs/:owner/:repo/:number',
    component: ({ params, sources }: PageProps) => <PrPage owner={params.owner!} repo={params.repo!} number={params.number!} sessions={sessionsOf(sources)} />,
  });

  ctx.contribute('palette-items', {
    items: (sources) => {
      const github = githubOf(sources);
      const seen = new Set<string>();
      return [...(github?.mine ?? []), ...(github?.reviewRequested ?? [])]
        .filter((p) => !seen.has(p.url) && !!seen.add(p.url))
        .map((p) => ({ id: `pr:${p.url}`, label: p.title, hint: `${p.repo}#${p.number}`, kind: 'pr', kindLabel: 'PR', to: `/prs/${p.repo}/${p.number}` }));
    },
  });

  ctx.contribute('job-kind', { kind: 'pr-session', icon: '⑂' });

  // Order 110: after other plugins' sign-in issues (lower orders).
  ctx.contribute('health-issues', {
    order: 110,
    collect: (sources) =>
      (githubOf(sources)?.mine ?? [])
        .filter((pr) => !pr.isDraft && pr.reviewDecision === 'CHANGES_REQUESTED')
        .map((pr): Issue => ({ level: 'fire', title: `Changes requested: ${pr.repo.split('/')[1]}#${pr.number}`, detail: pr.title, href: pr.url })),
  });

  // Details → Pull requests, between Links (10) and Worktrees (30) as before.
  ctx.contribute('workspace-section', {
    id: 'prs',
    title: 'Pull requests',
    order: 20,
    isEmpty: (ws, sources) => workspacePrs(ws, sources).length === 0,
    shownUrls: (ws, sources) => workspacePrs(ws, sources).map((p) => p.url),
    component: ({ workspace, sources }) => (
      <section className="block flush">
        <h3>Pull requests</h3>
        <PrPanel prs={workspacePrs(workspace, sources)} sessions={sessionsOf(sources)} onOpenSession={(sid) => navigate(`/sessions/${sid}`)} mine grouped emptyText="" />
      </section>
    ),
  });

  // A chip per PR on the workspace's card on the front page: its number and the most pressing thing about it.
  ctx.contribute('workspace-card', {
    id: 'prs',
    component: ({ workspace, sources }) => (
      <>
        {workspacePrs(workspace, sources).map((p) => {
          const c = prChip(p);
          return (
            <Link key={p.url} to={`/prs/${p.repo}/${p.number}`} className={`ws-pr-chip ${c.cls}`} title={c.title}>
              <span className="ws-pr-glyph">{c.glyph}</span> PR #{p.number} <span className="ws-pr-word">{c.word}</span>
            </Link>
          );
        })}
      </>
    ),
  });

  // "PR #n" / "Create PR ↗" on a worktree row; order 50 keeps it ahead of the core's "Adversarial review".
  ctx.contribute('worktree-action', {
    id: 'pr',
    order: 50,
    useData: (ws) => usePrChanges(ws),
    component: ({ workspace, worktree: t, sources, data }) => {
      const github = githubOf(sources);
      const prChanges = data as Record<number, boolean | null>;
      const pr = prFor(workspacePrs(workspace, sources), t);
      if (!isGitCopy(t) || !t.branch || !github?.host || !(pr || prChanges[t.id] !== false)) return null;
      return pr ? (
        <Link to={`/prs/${pr.repo}/${pr.number}`} className="small-text wt-pr">
          PR #{pr.number}
        </Link>
      ) : (
        <a href={createPrUrl(github.host, t.repo, t.branch, t.baseBranch)} target="_blank" rel="noreferrer" className="small-text wt-pr">
          Create PR ↗
        </a>
      );
    },
  });
}
