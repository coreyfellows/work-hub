#!/usr/bin/env node
/**
 * The /work-hub:scrutinize-pr skill's helper (beside its SKILL.md). Node builtins only (it runs from a session, outside the app).
 *
 *   node scrutinize-pr.ts candidates
 *       JSON: the PRs this session most likely means (its branch's PR, its work-hub workspace's PR links and the PRs
 *       of the workspace's worktree branches), each with why.
 *   node scrutinize-pr.ts start <number | owner/repo#n | PR URL> [--wait]
 *       Asks work-hub to write the PR's summary. A request file goes in the plugin's state folder
 *       (`<state dir>/plugins/scrutinize-pr/requests/`), which the server watches; it starts the same job the Summary
 *       tab's button does and answers in `<id>.response.json`. Prints that answer (JSON). `--wait` keeps waiting until
 *       the summary is written (up to 30 min) and prints where it is.
 *
 * Talking through the state folder rather than HTTP keeps the server's guard as it is (in hostname mode it refuses
 * loopback requests and wants a sign-in cookie): anything that can write there is already the user, as with `wh`.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PrRefArg {
  host: string | null;
  owner: string;
  repo: string;
  number: number;
}

const PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** `owner/repo` (and host) from a git remote URL. */
export function parseRemote(url: string): { host: string | null; owner: string; repo: string } | null {
  const u = url.trim();
  const m = u.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m || !PART.test(m[2]) || !PART.test(m[3])) return null;
  return { host: m[1], owner: m[2], repo: m[3] };
}

/** A PR from what the user typed: `123`, `#123`, `owner/repo#123` or a PR URL. A bare number needs `cwdRepo`. */
export function parseRefArg(arg: string, cwdRepo: { host: string | null; owner: string; repo: string } | null): PrRefArg {
  const a = arg.trim();
  let m = a.match(/^#?(\d+)$/);
  if (m) {
    if (!cwdRepo) throw new Error(`"${a}" is just a number, and this folder isn't a git repo with an origin: give owner/repo#${m[1]} or the PR's URL`);
    return { ...cwdRepo, number: Number(m[1]) };
  }
  m = a.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/);
  if (m) return { host: cwdRepo?.host ?? null, owner: m[1], repo: m[2], number: Number(m[3]) };
  m = a.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m && PART.test(m[2]) && PART.test(m[3])) return { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) };
  throw new Error(`can't read "${a}" as a PR: use a number, owner/repo#123 or the PR's URL`);
}

export const requestsDir = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.WORK_HUB_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'work-hub'), 'plugins', 'scrutinize-pr', 'requests');

const sh = (cmd: string, args: string[], cwd = process.cwd()) =>
  new Promise<string>((ok, fail) => execFile(cmd, args, { cwd, timeout: 30_000, maxBuffer: 16 << 20 }, (e, out, err) => (e ? fail(new Error(String(err || e.message).trim())) : ok(String(out)))));

async function cwdRepo() {
  const remote = await sh('git', ['remote', 'get-url', 'origin']).catch(() => '');
  return remote ? parseRemote(remote) : null;
}

/** This checkout's `bin/wh` (the script's real path is `<repo>/plugins/scrutinize-pr/skills/scrutinize-pr/`; Node resolves the core's symlink). */
const whBin = () => resolve(dirname(fileURLToPath(import.meta.url)), '../../../../bin/wh');

interface Candidate {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  why: string[];
}

async function candidates() {
  const repo = await cwdRepo();
  const branch = (await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
  const out = new Map<string, Candidate>();
  const add = (c: Omit<Candidate, 'why'>, why: string) => {
    const key = `${c.repo.toLowerCase()}#${c.number}`;
    const cur = out.get(key);
    if (cur) cur.why.push(why);
    else out.set(key, { ...c, why: [why] });
  };
  const ghPr = (args: string[], cwd?: string) => sh('gh', args, cwd).then((s) => JSON.parse(s) as unknown, () => null);
  const asCand = (p: { number: number; url: string; title: string; state: string }, fallbackRepo: string) => {
    const r = parseRefArg(p.url, null);
    return { repo: `${r.owner}/${r.repo}` || fallbackRepo, number: p.number, url: p.url, title: p.title, state: p.state };
  };

  if (repo && branch && branch !== 'HEAD') {
    const p = (await ghPr(['pr', 'view', '--json', 'number,url,title,state'])) as { number: number; url: string; title: string; state: string } | null;
    if (p?.url) add(asCand(p, `${repo.owner}/${repo.repo}`), `this folder's branch (${branch})`);
  }

  // The work-hub workspace this session belongs to: its PR links, and the PRs of its worktrees' branches.
  let workspace: { id: string; title: string } | null = null;
  const sid = process.env.CLAUDE_CODE_SESSION_ID ?? '';
  const shortId = process.env.CLAUDE_JOB_DIR ? process.env.CLAUDE_JOB_DIR.replace(/\/+$/, '').split('/').pop() : '';
  const list = await sh(whBin(), ['ls', '--json']).then((s) => JSON.parse(s) as Array<Record<string, unknown>>, () => []);
  const ws = list.find((w) => ((w.sessions as Array<{ claudeSessionId?: string; shortId?: string }>) ?? []).some((s) => (sid && s.claudeSessionId === sid) || (shortId && s.shortId === shortId)));
  if (ws) {
    workspace = { id: String(ws.id), title: String(ws.title) };
    for (const l of (ws.links as Array<{ url: string; label: string | null }>) ?? []) {
      const m = l.url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (m) add({ repo: `${m[1]}/${m[2]}`, number: Number(m[3]), url: l.url, title: l.label ?? '', state: '' }, 'linked to this workspace');
    }
    const trees = ((ws.worktrees as Array<{ path: string; branch: string | null }>) ?? []).filter((t) => t.branch && !/^(main|master|develop|dev|trunk)$/.test(t.branch)).slice(0, 5);
    for (const t of trees) {
      const prs = (await ghPr(['pr', 'list', '--head', t.branch!, '--state', 'all', '--limit', '3', '--json', 'number,url,title,state'], t.path)) as Array<{ number: number; url: string; title: string; state: string }> | null;
      for (const p of prs ?? []) add(asCand(p, ''), `this workspace's worktree branch ${t.branch}`);
    }
  }
  return { cwdRepo: repo ? `${repo.owner}/${repo.repo}` : null, branch, workspace, candidates: [...out.values()] };
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(arg: string, wait: boolean) {
  const ref = parseRefArg(arg, await cwdRepo());
  const dir = requestsDir();
  if (!(await exists(dir))) throw new Error(`work-hub isn't running the scrutinize-pr plugin here (no ${dir}). Turn it on in Settings → Plugins, or set WORK_HUB_STATE_DIR if work-hub uses another state dir.`);
  const id = randomUUID();
  const tmp = join(dir, `${id}.tmp`);
  await writeFile(tmp, JSON.stringify({ ...ref, requestedAt: new Date().toISOString(), sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null }), { mode: 0o600 });
  await rename(tmp, join(dir, `${id}.json`));
  const resp = join(dir, `${id}.response.json`);
  const deadline = Date.now() + (wait ? 35 * 60_000 : 15_000);
  let last: { status?: string } | null = null;
  while (Date.now() < deadline) {
    last = await readFile(resp, 'utf8').then((s) => JSON.parse(s) as { status?: string }, () => last);
    if (last && (!wait || last.status === 'done' || last.status === 'failed')) return last;
    await sleep(last ? 3000 : 500);
  }
  if (!last) throw new Error(`work-hub didn't pick up the request within 15s: is it running, with the scrutinize-pr plugin on? The request stays in ${dir} for an hour and runs if work-hub picks it up by then.`);
  return { ...last, note: 'still writing; gave up waiting' };
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'candidates') console.log(JSON.stringify(await candidates(), null, 1));
    else if (cmd === 'start' && rest.find((a) => !a.startsWith('--'))) {
      const r = await start(rest.find((a) => !a.startsWith('--'))!, rest.includes('--wait'));
      console.log(JSON.stringify(r, null, 1));
      if ((r as { status?: string }).status === 'failed') process.exitCode = 1;
    } else {
      console.error('usage: scrutinize-pr.ts candidates | start <number | owner/repo#n | PR URL> [--wait]');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`scrutinize-pr: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
