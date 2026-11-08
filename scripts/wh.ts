// `wh`: read and edit the work-hub workspace model from the command line. Agents use this to record
// the worktrees they create. Run as `~/repos/work-hub/bin/wh <command> …` (or `node scripts/wh.ts`).
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  addLink,
  addSession,
  addWorktree,
  allWorktrees,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  logEvent,
  setEpic,
  setStatus,
  updateWorkspace,
  type WorkspaceStatus,
} from '../server/store/workspaces.ts';
import { linkLabel } from '../server/lib/linkLabel.ts';
import { trustWorktree } from '../server/lib/sessions.ts';
import { callerSessionId, readJobSessionIdSync } from '../server/lib/callerSession.ts';
import { config, setFolderResolver } from '../server/config.ts';
import { expandFolder, folderTrustError, foldersGroup, PLAIN_KEY, REPOS_KEY, WORKTREES_KEY } from '../server/lib/folders.ts';
import { registerSettingsGroup, resolveFull } from '../server/settings.ts';

// The folders as the server sees them (env, else Settings → Folders, else the defaults), same as server/index.ts.
registerSettingsGroup(foldersGroup());
setFolderResolver((which) => {
  const v = resolveFull(which === 'repos' ? REPOS_KEY : which === 'plain' ? PLAIN_KEY : WORKTREES_KEY)?.value;
  return typeof v === 'string' && v.trim() ? expandFolder(v) : undefined;
});

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const USAGE = `wh: manage work-hub workspaces

  wh ls [--all] [--json]                       list workspaces (--all includes done)
  wh show <ws> [--json]                        one workspace with worktrees, sessions, views, links
  wh new --title <t> [--ticket KEY] [--prompt <p>]       create; prints the id
  wh worktree add <ws> --path <dir> [--repo owner/name] [--branch b] [--base b] [--vcs <id>]
                                               record a worktree (repo/branch detected from git if omitted;
                                               --vcs <id> records a non-git working copy as given, and a
                                               directory git doesn't know is recorded as vcs "folder",
                                               never a root folder or one containing it; a provider's copy
                                               re-recorded without --vcs keeps its vcs)
  wh session add <ws> --session <uuid> [--role explorer|main|review] [--name n]
  wh link add <ws> --url <u> [--kind pr|jira|url] [--label l]
  wh title <ws> <text>                         rename
  wh epic <ws> <EPIC-KEY> [title]              record the Jira epic ('none' if it has none)
  wh status <ws> setting-up|active|parked|done
  wh note <ws> <text>                          append a line to the notes
  wh claim <ws> <text>                         what this session is responsible for (latest wins)
  wh done <ws> <text>                          something this session finished
  wh log <ws> <type> [detail] [--session <uuid>]   add an activity event
  wh trust <dir>                               trust a worktree, a plain-root folder or a confirmed folder for claude --bg`;

const STATUSES = ['setting-up', 'active', 'parked', 'done'];

function die(msg: string): never {
  console.error(`wh: ${msg}`);
  process.exit(1);
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Why `path` is too broad to record as a plain folder, or null. A folder adopts every unrecorded session beneath it
 * (reconcile matches the deepest recorded path), so never the home folder or a system folder (`folderTrustError`), nor
 * the worktrees, repos or plain-workspaces root or a folder containing one.
 */
function folderBreadthError(path: string): string | null {
  const p = real(path);
  const bad = folderTrustError(p);
  if (bad) return bad;
  for (const [name, root] of [['worktrees', config.paths.worktrees], ['repos', config.paths.repos], ['plain workspaces', config.paths.plain]] as const) {
    const r = real(root);
    if (p === r || r.startsWith(p === '/' ? p : p + sep)) return `${p} is (or contains) the ${name} folder: pick a folder inside it`;
  }
  return null;
}

function need(ws: string | undefined): string {
  if (!ws) die('missing <ws> (a workspace id; see `wh ls`)');
  if (!getWorkspace(ws)) die(`no workspace "${ws}"`);
  return ws;
}

const { values: v, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: 'boolean' },
    json: { type: 'boolean' },
    title: { type: 'string' },
    ticket: { type: 'string' },
    prompt: { type: 'string' },
    path: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    base: { type: 'string' },
    vcs: { type: 'string' },
    session: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    kind: { type: 'string' },
    label: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, sub, ...rest] = pos;

/** The Claude session running this command (from its environment, or --session), so events can be shown per session. */
const caller = () => callerSessionId(process.env, (j) => readJobSessionIdSync(j), v.session);

if (!cmd || v.help) {
  console.log(USAGE);
  process.exit(0);
}

switch (cmd) {
  case 'ls': {
    const list = listWorkspaces({ includeDone: v.all });
    if (v.json) {
      console.log(JSON.stringify(list, null, 2));
      break;
    }
    for (const w of list) {
      const trees = w.worktrees.map((t) => `${(t.repo ?? '').split('/')[1]}@${t.branch ?? '?'}`).join(', ');
      console.log(`${w.id.padEnd(28)} ${w.status.padEnd(10)} ${w.title}${trees ? `  [${trees}]` : ''}`);
    }
    break;
  }
  case 'show': {
    const w = getWorkspace(need(sub));
    console.log(v.json ? JSON.stringify(w, null, 2) : JSON.stringify(w, null, 2));
    break;
  }
  case 'new': {
    if (!v.title && !v.ticket) die('--title or --ticket required');
    const id = createWorkspace({
      title: v.title ?? v.ticket!,
      origin: v.ticket ? 'ticket' : 'prompt',
      ticketKey: v.ticket ?? null,
      prompt: v.prompt ?? null,
    });
    console.log(id);
    break;
  }
  case 'worktree': {
    if (sub !== 'add') die('usage: wh worktree add <ws> --path <dir> …');
    const ws = need(rest[0]);
    if (!v.path) die('--path required');
    const path = resolve(v.path);
    if (v.vcs !== undefined && !/^[a-z][a-z0-9-]*$/.test(v.vcs)) die(`--vcs must be a lowercase id like git, jj or folder (got "${v.vcs}")`);
    // Already recorded by a provider (jj, hg, p4…) and re-recorded without --vcs (the explorer's step 4): keep its vcs and repo.
    const prior = v.vcs === undefined ? allWorktrees().find((t) => t.path === path && t.vcs !== 'git' && t.vcs !== 'folder') : undefined;
    const vcs = v.vcs ?? prior?.vcs;
    if (vcs && vcs !== 'git') {
      const repoArg = v.repo ?? prior?.repo ?? null;
      // A non-git working copy: recorded as given; wh can't load the provider plugins, so nothing is detected.
      if (!isDir(path)) die(`${path} doesn't exist (or isn't a directory)`);
      if (vcs === 'folder') {
        const broad = folderBreadthError(path);
        if (broad) die(`won't record ${path} as a folder: ${broad}`);
      }
      const branch = v.branch ?? prior?.branch ?? null;
      addWorktree(ws, { repo: repoArg, path, branch, baseBranch: v.base ?? null, vcs });
      console.log(vcs === 'folder' ? `recorded folder ${path} in ${ws}` : `recorded ${repoArg ?? vcs}@${branch ?? '?'} ${path} in ${ws}`);
      break;
    }
    const remote = git(path, ['remote', 'get-url', 'origin']);
    const top = git(path, ['rev-parse', '--show-toplevel']);
    // Repos with no origin (local-only) are recorded as local/<folder>.
    const repo = v.repo ?? remote?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? (top ? `local/${top.split(/[\\/]/).pop()}` : undefined);
    if (!repo && !v.vcs && isDir(path) && folderBreadthError(path) === null) {
      // Git doesn't know this directory: a plain folder.
      addWorktree(ws, { repo: null, path, branch: v.branch ?? null, baseBranch: v.base ?? null, vcs: 'folder' });
      console.log(`recorded folder ${path} in ${ws}`);
      break;
    }
    if (!repo) die(`couldn't detect the repo for ${path}; pass --repo owner/name`);
    const branch = v.branch ?? git(path, ['branch', '--show-current']);
    addWorktree(ws, { repo, path, branch, baseBranch: v.base ?? null, vcs: 'git' });
    console.log(`recorded ${repo}@${branch ?? '?'} ${path} in ${ws}`);
    break;
  }
  case 'session': {
    if (sub !== 'add') die('usage: wh session add <ws> --session <uuid> …');
    const ws = need(rest[0]);
    if (!v.session) die('--session required (full Claude session UUID)');
    addSession(ws, { claudeSessionId: v.session, role: v.role, name: v.name ?? null });
    console.log(`recorded session ${v.session.slice(0, 8)} in ${ws}`);
    break;
  }
  case 'link': {
    if (sub !== 'add') die('usage: wh link add <ws> --url <u> …');
    const ws = need(rest[0]);
    if (!v.url) die('--url required');
    addLink(ws, { kind: v.kind ?? (/\/pull\//.test(v.url) ? 'pr' : /atlassian|jira/.test(v.url) ? 'jira' : 'url'), url: v.url, label: v.label ?? null });
    logEvent(ws, 'link', linkLabel(v.url), caller());
    console.log(`linked ${v.url} to ${ws}`);
    break;
  }
  case 'status': {
    const ws = need(sub);
    const s = rest[0];
    if (!STATUSES.includes(s)) die(`status must be one of ${STATUSES.join(', ')}`);
    setStatus(ws, s as WorkspaceStatus);
    console.log(`${ws} is ${s}`);
    break;
  }
  case 'title': {
    const ws = need(sub);
    const text = rest.join(' ').trim();
    if (!text) die('title text required');
    updateWorkspace(ws, { title: text });
    logEvent(ws, 'title', text);
    console.log(`${ws} is now "${text}"`);
    break;
  }
  case 'epic': {
    const ws = need(sub);
    const key = rest[0];
    if (!key) die('usage: wh epic <ws> <EPIC-KEY> [title] | none');
    if (key === 'none') setEpic(ws, null, null);
    else setEpic(ws, key.toUpperCase(), rest.slice(1).join(' ').trim() || null);
    logEvent(ws, 'epic', key);
    console.log(`${ws} epic: ${key}`);
    break;
  }
  case 'note': {
    const ws = need(sub);
    const text = rest.join(' ').trim();
    if (!text) die('note text required');
    const prev = getWorkspace(ws)!.notes;
    updateWorkspace(ws, { notes: prev ? `${prev}\n${text}` : text });
    logEvent(ws, 'note', text.slice(0, 200));
    console.log(`noted on ${ws}`);
    break;
  }
  case 'claim':
  case 'done': {
    const ws = need(sub);
    const text = rest.join(' ').trim();
    if (!text) die(`${cmd} text required`);
    logEvent(ws, cmd, text, caller());
    console.log(cmd === 'claim' ? `claimed on ${ws}` : `recorded done on ${ws}`);
    break;
  }
  case 'log': {
    const ws = need(sub);
    if (!rest[0]) die('event type required');
    logEvent(ws, rest[0], rest.slice(1).join(' ') || undefined, caller());
    break;
  }
  case 'trust': {
    if (!sub) die('usage: wh trust <dir>');
    try {
      const r = await trustWorktree(resolve(sub));
      console.log(r.changed ? `trusted ${r.path}` : `already trusted: ${r.path}`);
    } catch (e) {
      die((e as Error).message);
    }
    break;
  }
  default:
    die(`unknown command "${cmd}"\n\n${USAGE}`);
}
