import { netItem, type GroupItem, type HistoryEntry, type WebPluginContext } from '../../../plugin-api/web.ts';
import { EditCard, FileGroupCard } from './EditCard.tsx';
import './styles.css';

function editState(e: HistoryEntry): 'running' | 'error' | 'done' {
  return e.result === undefined ? 'running' : e.isError ? 'error' : 'done';
}

export default function register(ctx: WebPluginContext): void {
  // File changes (Edit/Write…, and commands that changed files): one card each in the Log; in Chat a run of them (other tool
  // work in between doesn't break it) collapses into one card once there's >1, or one file's net change. Order 10: before
  // the git cards (20) and `!` runs (30), so one Bash call shows its file changes, then its git card.
  ctx.contribute('log-card', {
    id: 'edits',
    order: 10,
    match: (e) => e.kind === 'tool' && !!(e.edit || e.edits?.length),
    render: (e) => (
      <>
        {e.edit && <EditCard edit={e.edit} state={editState(e)} />}
        {e.edits?.map((ed) => <EditCard key={ed.path} edit={ed} state="done" />)}
      </>
    ),
    run: {
      key: () => 'edits',
      render: (entries) => {
        const run: Array<GroupItem & { at: string | null }> = entries.flatMap((e) =>
          e.edit ? [{ key: `e-${e.i}`, edit: e.edit, state: editState(e), at: e.at }] : (e.edits ?? []).map((ed, k) => ({ key: `e-${e.i}-${k}`, edit: ed, state: 'done' as const, at: e.at })),
        );
        // One file changed several times in a row: just its net change, as a normal card.
        const single = run.length > 1 && run.every((it) => it.edit.path === run[0]!.edit.path) ? netItem(run) : null;
        if (run.length === 1) return <EditCard edit={run[0]!.edit} state={run[0]!.state} />;
        if (single) return <EditCard edit={single.edit} state={single.state} />;
        return <FileGroupCard items={run} />;
      },
    },
  });
}
