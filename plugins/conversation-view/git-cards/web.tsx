import type { HistoryEntry, WebPluginContext } from '../../../plugin-api/web.ts';
import { GitCard } from './GitCard.tsx';
import type { GitOp } from './types.ts';
import './styles.css';

type CardState = 'running' | 'error' | 'done';

function callState(e: HistoryEntry): CardState {
  return e.result === undefined ? 'running' : e.isError ? 'error' : 'done';
}

/** The core types `HistoryEntry.git` opaquely; this plugin's server half writes it as `GitOp[]`. */
const opsOf = (e: HistoryEntry): GitOp[] => (e.git as GitOp[] | undefined) ?? [];

export default function register(ctx: WebPluginContext): void {
  // Git operations in a command: in Chat, ops of consecutive calls gather into one card (a commit and the merge after it
  // read as one). Order 20: after the file-change cards (edit-cards, 10) of the same call.
  ctx.contribute('log-card', {
    id: 'git',
    order: 20,
    match: (e) => e.kind === 'tool' && opsOf(e).length > 0,
    render: (e) => <GitCard ops={opsOf(e)} state={callState(e)} />,
    run: {
      key: () => 'git',
      render: (entries) => {
        let state: CardState = 'done';
        for (const e of entries) {
          const st = callState(e);
          if (st !== 'done' && state !== 'error') state = st;
        }
        return <GitCard ops={entries.flatMap(opsOf)} state={state} />;
      },
    },
  });
}
