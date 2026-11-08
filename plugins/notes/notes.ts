import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Workspace } from '../../plugin-api/server.ts';
import type { NoteInfo } from './types.ts';

export type { NoteInfo } from './types.ts';

/**
 * Each workspace's SilverBullet note, following the ticket-workflow conventions: ticket workspaces use the
 * ticket-workflow plugin's own ensure-ticket-note.sh (<notesDir>/tickets/<KEY>.md, same skeleton); other workspaces
 * get the same skeleton at <notesDir>/workspaces/<id>.md. SilverBullet is served under work-hub's own origin (at
 * `url`) by the front proxy, so it can be embedded.
 */

const exists = (p: string) => access(p).then(() => true, () => false);

export interface NotesOptions {
  /** Where SilverBullet keeps its pages. */
  notesDir: string;
  /** Where SilverBullet is served, e.g. "/notes". */
  url: string;
  /** The ticket-workflow plugin's scripts folder (ensure-ticket-note.sh); empty: ticket notes get the same skeleton made here. */
  scriptsDir: string;
  run: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<unknown>;
}

export type NoteWorkspace = Pick<Workspace, 'id' | 'ticketKey'>;

export function notePage(ws: NoteWorkspace): string {
  return ws.ticketKey ? `tickets/${ws.ticketKey.toUpperCase()}` : `workspaces/${ws.id}`;
}

export function createNotes(opts: NotesOptions) {
  const pageUrl = (page: string) => `${opts.url}/${page.split('/').map(encodeURIComponent).join('/')}`;
  const notePath = (ws: NoteWorkspace) => join(opts.notesDir, `${notePage(ws)}.md`);

  async function noteInfo(ws: NoteWorkspace): Promise<NoteInfo> {
    const page = notePage(ws);
    const path = notePath(ws);
    return { page, path, url: pageUrl(page), exists: await exists(path) };
  }

  /** Create the workspace's note if it doesn't exist yet; returns where it is. */
  async function ensureNote(ws: Workspace): Promise<NoteInfo> {
    const info = await noteInfo(ws);
    if (info.exists) return info;
    const worktree = ws.worktrees[0]?.path ?? '';
    if (ws.ticketKey && opts.scriptsDir) {
      const title = ws.title.replace(new RegExp(`^${ws.ticketKey}:?\\s*`, 'i'), '').trim();
      const args = [ws.ticketKey, '--path-only'];
      if (title && title !== ws.ticketKey) args.push('--title', title);
      if (worktree) args.push('--worktree', worktree);
      await opts.run(join(opts.scriptsDir, 'ensure-ticket-note.sh'), args, { timeoutMs: 15_000 });
    } else {
      await mkdir(dirname(info.path), { recursive: true });
      const body = [
        '---',
        ...(ws.ticketKey ? ['tags: ticket', `ticket: ${ws.ticketKey.toUpperCase()}`] : ['tags: workspace']),
        `workspace: ${ws.id}`,
        `worktree: ${worktree}`,
        `created: ${new Date().toISOString().slice(0, 10)}`,
        '---',
        `# ${ws.title}`,
        '',
        ...(ws.prompt ? [`> ${ws.prompt.split('\n').join('\n> ')}`, ''] : []),
        '## Scripts',
        '',
        '## Manual steps',
        '',
        '## Context',
        '',
      ].join('\n');
      // Don't clobber a note created in the meantime.
      await writeFile(info.path, body, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    return { ...info, exists: await exists(info.path) };
  }

  return { notePath, noteInfo, ensureNote };
}

