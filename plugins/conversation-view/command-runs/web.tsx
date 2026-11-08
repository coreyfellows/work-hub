import { useContext, type ReactNode } from 'react';
import { hastText, LogViewContext, logTime, type HistoryEntry, type WebPluginContext } from '../../../plugin-api/web.ts';
import { bangCommand, CommandCard, CommandRunsContext, PendingRuns, ShellCard, ShellRunsContext, shellRuns, useCommandRuns } from './CommandCard.tsx';
import './styles.css';

/** The session's `!` runs (Run records and the transcript's own), for the command cards anywhere in the log. */
function CommandRunsWrap({ sessionId, entries, children }: { sessionId: string; entries: HistoryEntry[]; children: ReactNode }) {
  // Run-button records (durable, from the workspace DB), re-read whenever the conversation grows.
  const commandRuns = useCommandRuns(sessionId, entries.length);
  return (
    <CommandRunsContext.Provider value={commandRuns}>
      <ShellRunsContext.Provider value={shellRuns(entries)}>{children}</ShellRunsContext.Provider>
    </CommandRunsContext.Provider>
  );
}

export default function register(ctx: WebPluginContext): void {
  // A `!` command you ran (bash mode): its output card; in the Log, the whole `!` row. After edit (10) and git (20) cards.
  ctx.contribute('log-card', {
    id: 'shell',
    order: 30,
    match: (e) => !!e.shell,
    label: 'You ran',
    Wrap: CommandRunsWrap,
    Pending: PendingRuns,
    render: (e, { readable }) =>
      readable ? (
        <ShellCard e={e} />
      ) : (
        <div className="h-user h-shell">
          <span className="h-prompt">!</span>
          <div className="h-text">
            <ShellCard e={e} />
          </div>
          {e.at && <span className="h-time">{logTime(e.at)}</span>}
        </div>
      ),
  });

  // A fenced block that is exactly one `! <command>` line (see bangCommand) becomes a CommandCard, in Chat only (the raw
  // Log draws it as code).
  ctx.contribute('markdown-override', {
    tag: 'pre',
    component: function Pre({ node, children, ...rest }: { node?: unknown; children?: ReactNode }) {
      const view = useContext(LogViewContext);
      const cmd = view?.readable ? bangCommand(hastText(node)) : null;
      if (cmd) return <CommandCard command={cmd} />;
      return <pre {...rest}>{children}</pre>;
    },
  });
}
