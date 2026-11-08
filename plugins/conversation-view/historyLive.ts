import type { ServerPluginContext, Session } from '../../plugin-api/server.ts';
import { createTranscriptWatcher, type TranscriptWatcher } from './transcriptWatch.ts';

/** How often to look again for a transcript that doesn't exist yet (a session that has only just started). */
const FIND_RETRY_MS = 2000;

/**
 * `GET /api/sessions/:id/history/live`: a WebSocket that says `{"t":"changed"}` whenever the session's transcript
 * changes, so the session page fetches `history?after=` at once instead of on its next poll. It carries no
 * conversation itself: the page's fetch stays the one path for entries (ETag, paging, enrichers). `{"t":"ready"}`
 * is sent once the transcript is being watched. The page keeps a slow poll beside it for what enrichers add from
 * elsewhere, and doesn't open it in low data.
 */
export function registerHistoryLive(ctx: ServerPluginContext, watcher: TranscriptWatcher = createTranscriptWatcher()): void {
  ctx.app.get('/api/sessions/:id/history/live', async (c, next) => {
    // Browsers don't apply same-origin rules to WebSockets: check the Origin here (the guard checks Host and sign-in).
    if (!ctx.isAcceptedOrigin(c.req.header('origin'))) return c.text('forbidden origin', 403);
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    c.set('historySession' as never, s as never);
    return next();
  }, ctx.upgradeWebSocket((c) => {
    const s = c.get('historySession' as never) as unknown as Session;
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    return {
      onOpen(_evt, ws) {
        const send = (t: string) => {
          try {
            ws.send(JSON.stringify({ t }));
          } catch {
            /* closing */
          }
        };
        const attach = async () => {
          retry = null;
          const path = await ctx.sessions.findTranscript(s.sessionId).catch(() => null);
          if (closed) return;
          if (!path) {
            retry = setTimeout(() => void attach(), FIND_RETRY_MS);
            return;
          }
          unsubscribe = watcher.subscribe(path, () => send('changed'));
          send('ready');
        };
        void attach();
      },
      onClose() {
        closed = true;
        if (retry) clearTimeout(retry);
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  }));
}
