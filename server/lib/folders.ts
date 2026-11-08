/**
 * The two folders the app works from: where your repos are cloned and where worktrees are created. Both are Settings
 * (group `folders`, stored in `app_settings`; the env vars WORK_HUB_REPOS_DIR / TW_WORKTREES_ROOT still win) and are read
 * on every use through `config.paths`, so a change applies without a restart. A first-run page asks for them once.
 */
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { SettingDef } from '../../plugin-api/manifest.ts';
import type { SettingGroup } from '../settings.ts';

export const FOLDERS_GROUP = 'folders';
export const REPOS_KEY = `${FOLDERS_GROUP}.reposDir`;
export const WORKTREES_KEY = `${FOLDERS_GROUP}.worktreesDir`;
/** Set (to true) once the first-run page has been answered, so it never shows again. */
export const CLEANUP_KEY = `${FOLDERS_GROUP}.cleanupOnClose`;
export const SETUP_DONE_KEY = 'setup.folders';

export function folderDefs(home: string = homedir()): SettingDef[] {
  return [
    {
      key: 'reposDir',
      label: 'Repos folder',
      description: 'Where your repositories are cloned (one folder per repo). Pull request sessions look repos up here, and the file viewer and "View script" may open files under it.',
      type: 'string',
      default: `${home}/repos`,
      placeholder: '~/repos',
      env: 'WORK_HUB_REPOS_DIR',
    },
    {
      key: 'worktreesDir',
      label: 'Worktrees folder',
      description: 'Where new worktrees go, as <folder>/<repo>/<ticket or short name>. Sessions may only be started and trusted inside it.',
      type: 'string',
      default: `${home}/worktrees`,
      placeholder: '~/worktrees',
      env: 'TW_WORKTREES_ROOT',
    },
    {
      key: 'cleanupOnClose',
      label: "Remove a session's worktrees when it is closed",
      description:
        'Closing a session removes the worktrees only it was using, but only when nothing is lost: no uncommitted changes and every commit already on another branch or a remote. Anything else stays and is listed under Orphaned in the workspace.',
      type: 'boolean',
      default: true,
    },
  ];
}

export function foldersGroup(home?: string): SettingGroup {
  return {
    id: FOLDERS_GROUP,
    title: 'Folders',
    description: 'Where work-hub finds your repos and creates worktrees. Changes apply to the next thing you do; running sessions keep their folders.',
    order: 25,
    builtin: true,
    defs: folderDefs(home),
  };
}

/** `~`, `~/x` → the home folder; trailing slashes dropped. Not checked: see `folderError`. */
export function expandFolder(raw: string, home: string = homedir()): string {
  const t = raw.trim();
  const p = t === '~' ? home : t.startsWith('~/') ? home + t.slice(1) : t;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Why `raw` can't be a folder setting, or null. Shape only (absolute path, not the filesystem root); existence is `checkFolder`. */
export function folderError(raw: unknown, home?: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'a folder is required';
  const p = expandFolder(raw, home);
  if (!isAbsolute(p)) return `${raw}: use an absolute path (or start with ~/)`;
  if (resolve(p) === '/') return 'the filesystem root is not a valid folder';
  if (p.includes('\0')) return 'invalid path';
  return null;
}

/** Existence of the folder: 'dir', 'missing', or 'file' (something else is in the way). */
export async function folderState(path: string): Promise<'dir' | 'missing' | 'file'> {
  const st = await stat(path).catch(() => null);
  return !st ? 'missing' : st.isDirectory() ? 'dir' : 'file';
}

export interface FolderCheck {
  error?: string;
  /** The (expanded) folder, when it is usable. */
  path?: string;
}

/**
 * First-run answer for one folder: it must exist, except the worktrees folder (`create`), which is made when missing
 * (worktrees are created inside it by the app, so it is ours to create; repos are yours).
 */
export async function checkFolder(raw: unknown, opts: { create: boolean; home?: string }): Promise<FolderCheck> {
  const bad = folderError(raw, opts.home);
  if (bad) return { error: bad };
  const path = expandFolder(raw as string, opts.home);
  const state = await folderState(path);
  if (state === 'file') return { error: `${path} is a file, not a folder` };
  if (state === 'missing') {
    if (!opts.create) return { error: `${path} doesn't exist` };
    await mkdir(path, { recursive: true });
  }
  return { path };
}
