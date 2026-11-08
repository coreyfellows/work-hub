import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { createNotes } from './notes.ts';

/**
 * Origins that always get a worktree, which their creator may record a little later (a PR session records it once
 * Claude has started; an adversarial review right away).
 */
const WAITS_FOR_WORKTREE = new Set(['pr', 'review']);
/** How long a new workspace of those origins waits for its worktree before its note is made without one. */
const WORKTREE_WAIT_MS = 2 * 60_000;

export default function register(ctx: ServerPluginContext): void {
  const home = homedir();
  const notes = createNotes({
    // Old env names are still honoured as defaults (WORK_HUB_NOTES_URL is already this plugin's own name for `url`).
    notesDir: ctx.config.get('notesDir', process.env.TW_NOTES_DIR ?? join(home, 'notes')),
    url: ctx.config.get('url', '/notes'),
    // ensure-ticket-note.sh comes from the ticket-workflow plugin (read on use: it may load after this one, or be off).
    get scriptsDir() {
      return ctx.paths.ticketWorkflowScripts;
    },
    run: ctx.exec.run,
  });
  ctx.services.expose('notes', notes);

  // New and review sessions are told where the workspace's note is, if it has one.
  ctx.prompts.addFragment('session-context', ({ workspaceId, ticketKey }) => {
    if (!workspaceId) return null;
    const path = notes.notePath({ id: workspaceId, ticketKey: typeof ticketKey === 'string' ? ticketKey : null });
    return existsSync(path) ? `- Its note (scripts, manual steps, context): ${path}` : null;
  });

  // Every new workspace gets its note (failure here shouldn't block the work; it's logged on the workspace).
  const create = (id: string) => {
    const ws = ctx.store.getWorkspace(id);
    if (!ws) return;
    return notes.ensureNote(ws).then(
      (n) => ctx.store.logEvent(id, 'note', n.page),
      (e: unknown) => ctx.store.logEvent(id, 'note-failed', (e as Error).message),
    );
  };
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  ctx.events.on('workspace-event', (e) => {
    if (e.type === 'created') {
      // After the creator's synchronous follow-up (worktree, links), so the note can name the worktree.
      setImmediate(() => {
        const ws = ctx.store.getWorkspace(e.workspaceId);
        if (!ws) return;
        if (!ws.worktrees.length && WAITS_FOR_WORKTREE.has(ws.origin)) {
          const timer = setTimeout(() => {
            waiting.delete(ws.id);
            if (ctx.store.getWorkspace(ws.id)?.status !== 'done') void create(ws.id); // done = its session never started
          }, WORKTREE_WAIT_MS);
          timer.unref();
          waiting.set(ws.id, timer);
          return;
        }
        void create(ws.id);
      });
    } else if (e.type === 'worktree' && waiting.has(e.workspaceId)) {
      clearTimeout(waiting.get(e.workspaceId));
      waiting.delete(e.workspaceId);
      void create(e.workspaceId);
    }
  });

  /** The workspace's note (for the Note tab). */
  ctx.app.get('/api/plugins/notes/workspaces/:id', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    return c.json(await notes.noteInfo(ws));
  });

  /** Create the workspace's note if it's missing. */
  ctx.app.post('/api/workspaces/:id/note', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    try {
      return c.json(await notes.ensureNote(ws));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
