/**
 * The folder provider: a plain directory with no version control. It matches any path (the fallback), has no identity
 * or line, and removing one only forgets the record: files are never deleted.
 */
import { stat } from 'node:fs/promises';
import type { SourceControlProvider } from './types.ts';

export const folderProvider: SourceControlProvider = {
  id: 'folder',
  title: 'Plain folder',
  detect: async (path) => path,
  identity: async () => ({ repo: null }),
  line: async () => ({ line: null, head: null }),
  sharedLines: new Set<string>(),
  inspect: async (root) => ({
    exists: await stat(root).then((s) => s.isDirectory(), () => false),
    dirty: false,
    unsaved: 0,
    removable: true,
    block: null,
  }),
  // Record only: the caller forgets it; nothing on disk changes.
  removeWorkingCopy: async () => {},
  agentInstructions: (o) => [
    `This workspace's folder is a plain directory (no version control): work in it directly; record another folder with \`${o.whCommand} worktree add ${o.workspaceId} --path <dir> --vcs folder\`.`,
  ],
  prereq: async () => ({ ok: true, detail: 'nothing to install' }),
};
