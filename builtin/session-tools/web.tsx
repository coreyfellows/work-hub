import { useEffect, useState } from 'react';
import { navigate, post, useToast, type MenuItem, type Session, type WebPluginContext, type WorkspaceTabKindContext, type WorkspaceTabKindState } from '../../plugin-api/web.ts';
import { setBusy, useBusy } from './busy.ts';
import { HandoffDialog } from './HandoffDialog.tsx';
import { NewSessionModal } from './NewSessionBox.tsx';
import './styles.css';

/**
 * "New session" first in the workspace tab strip's + menu (a tab kind with no tabs: its menu entries come before the
 * terminals', where a `tabstrip-action` would sit last), and its form as a modal drawn after the + button.
 */
// `palette: false`: the palette has "New session in this workspace" (below), which also works from a session's page.
function useNewSession({ workspace }: WorkspaceTabKindContext): WorkspaceTabKindState {
  const [composing, setComposing] = useState(false);
  // The palette's "New session in this workspace": asked for before this page mounted (from a session page), or now.
  useEffect(() => {
    if (!workspace) return;
    const take = () => {
      if (pendingNewSession !== workspace.id) return;
      pendingNewSession = null;
      setComposing(true);
    };
    take();
    window.addEventListener(NEW_SESSION_EVENT, take);
    return () => window.removeEventListener(NEW_SESSION_EVENT, take);
  }, [workspace?.id]);
  const menu: MenuItem[] = workspace ? [{ label: composing ? 'Hide new session form' : 'New session', onSelect: () => setComposing((v) => !v), palette: false }] : [];
  return {
    tabs: [],
    active: null,
    pane: null,
    clear: () => {},
    menu,
    after: composing && workspace ? <NewSessionModal ws={workspace} onClose={() => setComposing(false)} /> : null,
  };
}

const NEW_SESSION_EVENT = 'session-tools:new-session';
let pendingNewSession: string | null = null;

/** Opens the new session form on the workspace's page (going there first when elsewhere, e.g. one of its sessions' pages). */
function openNewSession(workspaceId: string): void {
  pendingNewSession = workspaceId;
  navigate(`/workspaces/${encodeURIComponent(workspaceId)}`);
  window.dispatchEvent(new Event(NEW_SESSION_EVENT));
}

/** Close (stop) the session; its record stays, and `claude attach` reopens it. */
function useCloseItem({ session, workspaceId }: { session: Session; workspaceId?: string }): MenuItem | null {
  const busy = useBusy(session.sessionId);
  const { show: toast } = useToast();
  if (!workspaceId) return null;
  return {
    label: busy === 'close' ? 'Closing…' : 'Close session',
    disabled: !!busy,
    onSelect: () => {
      setBusy(session.sessionId, 'close');
      post(`/api/workspaces/${workspaceId}/sessions/${session.sessionId}/close`)
        .then(() => toast({ text: `Closed ${session.name}. \`claude attach\` reopens it.` }))
        .catch((e: Error) => toast({ kind: 'error', text: e.message }))
        .finally(() => setBusy(session.sessionId, null));
    },
  };
}

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('workspace-tab-kind', { id: 'new-session', prefix: 'new-session-', order: 10, useTabs: useNewSession });
  ctx.contribute('palette-commands', {
    order: 20,
    commands: ({ workspaceId }) =>
      workspaceId ? [{ id: 'new-session', label: 'New session in this workspace', hint: 'pick a prompt and model', group: 'Session', run: () => openNewSession(workspaceId) }] : [],
  });
  // Workspace sessions only (the session page outside a workspace has no `workspaceId`): after the core's "Intent".
  ctx.contribute('session-action', {
    id: 'handoff',
    useItem: function useHandoffItem({ session, workspaceId }) {
      const busy = useBusy(session.sessionId);
      if (!workspaceId) return null;
      return { label: busy === 'handoff' ? 'Handing off…' : 'Hand off', disabled: busy === 'handoff' };
    },
    dialog: HandoffDialog,
  });
  ctx.contribute('session-action', { id: 'close', useItem: useCloseItem });
  for (const [kind, icon] of [
    ['handoff', '⇄'],
    ['new-session', '＋'],
  ] as const)
    ctx.contribute('job-kind', { kind, icon });
}
