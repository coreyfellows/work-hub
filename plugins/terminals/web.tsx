import {
  TerminalRunContext,
  useToast,
  usePersistedPick,
  type MenuItem,
  type WebPluginContext,
  type WorkspaceTabKindContext,
  type WorkspaceTabKindState,
} from '../../plugin-api/web.ts';
import { TerminalPage } from './TerminalPage.tsx';
import { guessSize, TermPane, TermTab, useTerms } from './Terminals.tsx';
import './styles.css';

/** A workspace's terminals in its tab strip (ids `t-<id>`), their + menu entries, and the "▶ Terminal" handler for its sessions' cards. */
function useWorkspaceTerminals({ workspaceId, workspace, paneRef, selectedSession, took }: WorkspaceTabKindContext): WorkspaceTabKindState {
  const { show: toast } = useToast();
  const wsTerms = useTerms(`/api/workspaces/${workspaceId}/terms`, (text) => toast({ kind: 'error', text }));
  // Which terminal tab you were on is remembered per workspace (localStorage), so a reload or coming back reopens it.
  const [termPick, setTermPick] = usePersistedPick(`wh.ws.${workspaceId}.term`);
  const termView = wsTerms.terms?.find((t) => t.id === termPick) ?? null;
  const worktrees = workspace?.worktrees ?? [];

  const newTerm = async (cwd?: string) => {
    const t = await wsTerms.create(cwd, guessSize(paneRef.current));
    if (t) {
      setTermPick(t.id);
      took();
    }
  };
  // A script's "▶ Terminal" button: a new terminal in the session's worktree (else the default folder), running it.
  const runInTerminal = async (command: string, sessionId: string) => {
    const cwd = worktrees.find((w) => w.path === selectedSession?.cwd)?.path;
    const t = await wsTerms.create(cwd, guessSize(paneRef.current), { command, sessionId });
    if (!t) throw new Error(wsTerms.error ?? "couldn't open a terminal");
    setTermPick(t.id);
    took();
  };
  const closeTerm = async (t: NonNullable<typeof termView>) => {
    await wsTerms.close(t);
    if (t.id === termPick) setTermPick(null);
  };

  const repoName = (r: string) => r.split('/')[1] ?? r;
  const menu: MenuItem[] =
    worktrees.length > 1
      ? [{ label: 'New terminal', submenu: worktrees.map((t): MenuItem => ({ label: `${repoName(t.repo)} @${t.branch ?? '?'}`, disabled: wsTerms.busy, onSelect: () => void newTerm(t.path) })) }]
      : [{ label: 'New terminal', disabled: wsTerms.busy, onSelect: () => void newTerm(worktrees[0]?.path) }];

  return {
    tabs: (wsTerms.terms ?? []).map((t, i) => ({
      id: `t-${t.id}`,
      node: (
        <TermTab
          t={t}
          index={i}
          on={t.id === termView?.id}
          onPick={(x) => {
            setTermPick(x.id);
            took();
          }}
          onClose={(x) => void closeTerm(x)}
          onRename={(x, title) => void wsTerms.rename(x, title)}
        />
      ),
    })),
    active: termView ? `t-${termView.id}` : null,
    pending: !!termPick && wsTerms.terms === null,
    pane: termView ? <TermPane key={termView.id} term={termView} onRestart={() => void wsTerms.restart(termView)} onClose={() => void closeTerm(termView)} /> : null,
    clear: () => setTermPick(null),
    // "New terminal" entries go in the + menu right after "New session", as before (a `tabstrip-action` would sit last).
    menu,
    after: !!wsTerms.terms?.length && wsTerms.asOf,
    banner: wsTerms.error ? <div className="error">{wsTerms.error}</div> : null,
    wrapSession: (children) => <TerminalRunContext.Provider value={runInTerminal}>{children}</TerminalRunContext.Provider>,
  };
}

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('page', { path: '/terminal', nav: { label: 'Terminal', secondary: true, title: 'Terminals on this machine' }, component: () => <TerminalPage /> });
  ctx.contribute('workspace-tab-kind', { id: 'terminals', prefix: 't-', useTabs: useWorkspaceTerminals });
}
