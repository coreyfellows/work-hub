import type { Session } from '../api.ts';
import { statusLabel, statusTitle } from '../status.ts';

/** A session's status pill; `unread` (said something since you last looked) puts a dot inside it, before the label. */
export function StatusBadge({ status, session, unread = false }: { status: string; session?: Session; unread?: boolean }) {
  const title = statusTitle(session);
  return (
    <span className={`badge st-${status} ${unread ? 'unread' : ''}`} title={unread ? [title, 'New since you last looked'].filter(Boolean).join(' · ') : title}>
      {unread && <span className="unread-dot" role="img" aria-label="unread" />}
      {statusLabel(status, session)}
    </span>
  );
}
