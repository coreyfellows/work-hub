import type { ServerPluginContext } from '../../plugin-api/server.ts';
import bashSnapshots from './bash-snapshots/server.ts';
import commandRuns from './command-runs/server.ts';
import editCards from './edit-cards/server.ts';
import fileLinks from './file-links/server.ts';
import gitCards from './git-cards/server.ts';
import { registerHistoryLive } from './historyLive.ts';
import permissions from './permissions/server.ts';
import questions from './questions/server.ts';
import slashPicker from './slash-picker/server.ts';

export default function register(ctx: ServerPluginContext): void {
  // The conversation's features, in the order they loaded as separate plugins (enrichers run in this order).
  // Snapshots of what Bash commands changed need a hook in the session, so they can be switched off (setting `bashSnapshots`, on by default).
  if (ctx.config.get('bashSnapshots', true)) bashSnapshots(ctx);
  commandRuns(ctx);
  // The UI fetches it when the live socket says the transcript changed, and polls it (slowly beside the socket, every few
  // seconds without it, every 10s in low data): an unchanged page is an empty 304.
  ctx.revalidate(['/api/sessions/:id/history']);

  /** The session's conversation from its transcript, paged (`before`/`after` entry index, `limit`; see the core's readHistory). */
  ctx.app.get('/api/sessions/:id/history', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const num = (k: string) => {
      const v = c.req.query(k);
      return v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v);
    };
    const page = await ctx.sessions.readHistory(s.sessionId, { before: num('before'), after: num('after'), limit: num('limit') });
    return page ? c.json(page) : c.json({ entries: [], start: 0, total: 0, noticeCount: 0 });
  });
  // Push beside the poll: a WebSocket that says when the transcript changed, so the page fetches at once.
  registerHistoryLive(ctx);

  // The Activity view: hook feedback and task notifications, kept out of Chat and Log. Fetched when the history route's
  // `noticeCount` changes, so it rides the history poll instead of polling itself.
  ctx.revalidate(['/api/sessions/:id/activity']);
  ctx.app.get('/api/sessions/:id/activity', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    const r = await ctx.sessions.readNotices(s.sessionId);
    return c.json(r ?? { notices: [], total: 0 });
  });

  fileLinks(ctx);
  gitCards(ctx);
  editCards(ctx);
  questions(ctx);
  slashPicker(ctx);
  permissions(ctx);
}
