import type { SessionViewProps, WebPluginContext } from '../../plugin-api/web.ts';
import { SessionIdContext } from '../../plugin-api/web.ts';
import { ActivityView } from './Activity.tsx';
import { History, LogWraps } from './History.tsx';
import { Composer } from './composer/Composer.tsx';
import commandRuns from './command-runs/web.tsx';
import editCards from './edit-cards/web.tsx';
import fileLinks from './file-links/web.tsx';
import gitCards from './git-cards/web.tsx';
import permissions from './permissions/web.tsx';
import questions from './questions/web.tsx';
import slashPicker from './slash-picker/web.tsx';

/**
 * The conversation: Chat (`readable`) and Log share this one instance (same component). It stays mounted while another
 * view shows (drawing nothing inside the log-card Wraps), so what the Wraps hold (e.g. the `!` command runs) survives.
 */
function ConversationView({ session, sessionId, visible, readable, history, pending = [], working, stopping, pressKey, stop }: SessionViewProps) {
  if (!history) return null;
  return (
    <LogWraps sessionId={sessionId} entries={history.entries}>
      {visible && (
        <>
          {history.hasMore && (
            <button className="link load-earlier" onClick={history.loadEarlier} disabled={history.loading}>
              {history.loading ? 'Loading…' : `Load earlier (${history.earlier} more)`}
            </button>
          )}
          {history.entries.length > 0 || pending.length > 0 || working ? (
            <SessionIdContext.Provider value={sessionId}>
              <History
                sessionId={sessionId}
                entries={history.entries}
                pending={pending}
                readable={!!readable}
                hidePendingQuestion={session.kind === 'background'}
                working={working}
                resident={history.resident}
                onSendNow={working && pressKey ? () => pressKey('C-X-C-S') : undefined}
                onStop={working && !stopping ? stop : undefined}
              />
            </SessionIdContext.Provider>
          ) : (
            <div className="muted">No conversation yet.</div>
          )}
        </>
      )}
    </LogWraps>
  );
}

export default function register(ctx: WebPluginContext): void {
  commandRuns(ctx);
  ctx.contribute('session-view', { id: 'chat', label: 'Chat', order: 20, default: true, needsHistory: true, readable: true, component: ConversationView, footer: Composer });
  ctx.contribute('session-view', { id: 'log', label: 'Log', order: 30, needsHistory: true, component: ConversationView });
  // Hook feedback and task notifications, kept out of Chat and Log (needsHistory: it reloads when `noticeCount` changes).
  ctx.contribute('session-view', { id: 'activity', label: 'Activity', order: 35, needsHistory: true, component: ActivityView });
  // The Chat view's prompt box (composer/Composer.tsx).
  ctx.contribute('shortcut', { group: 'Prompt box', order: 10, keys: ['Enter'], label: 'Send' });
  ctx.contribute('shortcut', { group: 'Prompt box', order: 10, keys: ['Shift+Enter'], label: 'New line' });
  ctx.contribute('shortcut', { group: 'Prompt box', order: 10, keys: ['Escape'], label: 'Stop the session', where: 'while it is working' });
  ctx.contribute('shortcut', { group: 'Prompt box', order: 10, keys: ['Tab'], label: 'Jump into the prompt box', where: 'when nothing on the page has focus' });
  fileLinks(ctx);
  gitCards(ctx);
  editCards(ctx);
  questions(ctx);
  permissions(ctx);
  slashPicker(ctx);
}
