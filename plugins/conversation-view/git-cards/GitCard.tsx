import { useContext, useEffect, useState, type ReactNode } from 'react';
import { FilesBrowser, get, Modal, Row, SessionIdContext, type FileEdit, type FileNode } from '../../../plugin-api/web.ts';
import type { GitCommit, GitOp } from './types.ts';

/** A commit's files as a tree beside the selected file's diff (fetched when the dialog opens). */
function CommitBrowser({ dir, c }: { dir: string; c: GitCommit }) {
  const sessionId = useContext(SessionIdContext);
  const [edits, setEdits] = useState<FileEdit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState(c.files[0]?.path ?? '');
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    get<{ files: FileEdit[] }>(`/api/sessions/${sessionId}/commit-diff?dir=${encodeURIComponent(dir)}&sha=${encodeURIComponent(c.sha)}`)
      .then((r) => alive && setEdits(r.files))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [sessionId, dir, c.sha]);
  const files: FileNode[] = c.files.map((f) => {
    const edit = edits?.find((e) => e.path === f.path || e.path.endsWith(`/${f.path}`));
    return {
      path: f.path,
      edits: [],
      net: edit ? { key: f.path, edit, state: 'done' } : null,
      added: f.add ?? 0,
      removed: f.del ?? 0,
      created: f.status === 'A',
      failed: false,
      status: f.status,
    };
  });
  if (!files.length) return <div className="edit-dir modal-empty">No file changes.</div>;
  return (
    <FilesBrowser
      files={files}
      selected={sel}
      onSelect={setSel}
      empty={failed || !sessionId ? "Couldn't load this commit's diff." : edits === null ? 'Loading…' : 'No text diff (binary or too large).'}
    />
  );
}

/** `~/…/repo` for a directory, keeping only the last two parts. */
const shortDir = (d: string) => d.replace(/^\/Users\/[^/]+/, '~').split('/').slice(-2).join('/');

const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: 'added', cls: 'add' },
  D: { label: 'deleted', cls: 'del' },
  M: { label: 'modified', cls: 'mod' },
  T: { label: 'type changed', cls: 'mod' },
};

function fileList(names: string[]): string {
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

function CommitFiles({ c }: { c: GitCommit }) {
  return (
    <ul className="git-files">
      {c.files.map((f) => {
        const s = STATUS[f.status] ?? { label: f.status, cls: 'mod' };
        return (
          <li key={f.path}>
            <span className={`git-st ${s.cls}`} title={s.label}>
              {f.status}
            </span>
            <span className="git-path">{f.path}</span>
            <span className="edit-stat">
              {!!f.add && <span className="add">+{f.add}</span>}
              {!!f.del && <span className="del">−{f.del}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function commitStat(c: GitCommit) {
  const add = c.files.reduce((n, f) => n + (f.add ?? 0), 0);
  const del = c.files.reduce((n, f) => n + (f.del ?? 0), 0);
  const created = c.files.filter((f) => f.status === 'A').length;
  const deleted = c.files.filter((f) => f.status === 'D').length;
  return (
    <span className="edit-stat">
      <span className="edit-lines">
        {c.files.length} {c.files.length === 1 ? 'file' : 'files'}
      </span>
      {created > 0 && <span className="add">{created} new</span>}
      {deleted > 0 && <span className="del">{deleted} deleted</span>}
      {add > 0 && <span className="add">+{add}</span>}
      {del > 0 && <span className="del">−{del}</span>}
    </span>
  );
}

/** What one row's dialog shows: a file browser for its commits (a picker on top when there are several), else the details list. */
function OpDetail({ op, merge, push, body }: { op: GitOp; merge?: GitOp; push?: GitOp; body: ReactNode }) {
  const commits = op.commits ?? [];
  const [pick, setPick] = useState(0);
  const shownCommit = commits[Math.min(pick, commits.length - 1)];
  const extras = [...(op.refs ?? []), ...(push?.refs ?? []), ...(op.moves ?? []), ...(merge?.moves ?? [])];
  if (!shownCommit) return <>{body}</>;
  return (
    <div className="git-modal-col">
      {(commits.length > 1 || extras.length > 0) && (
        <div className="git-modal-top">
          {commits.length > 1 &&
            commits.map((c, k) => (
              <button key={c.sha} type="button" className={`git-pick${c === shownCommit ? ' sel' : ''}`} onClick={() => setPick(k)}>
                <code className="git-sha">{c.sha}</code> {c.subject}
              </button>
            ))}
          {extras.map((m, k) => (
            <div key={k} className="git-ref">
              {m}
            </div>
          ))}
        </div>
      )}
      <CommitBrowser key={shownCommit.sha} dir={op.dir} c={shownCommit} />
    </div>
  );
}

function opBody(op: GitOp, merge?: GitOp, push?: GitOp): ReactNode {
  const commits = op.commits ?? [];
  const files = op.files ?? [];
  return    commits.length > 0 || files.length > 3 || (op.refs?.length ?? 0) > 0 || (op.moves?.length ?? 0) > 0 || (merge?.moves?.length ?? 0) > 0 || (push?.refs?.length ?? 0) > 0 ? (
      <div className="git-body">
        {commits.map((c) => (
          <div key={c.sha} className="git-commit">
            {commits.length > 1 && (
              <div className="git-commit-head">
                <code className="git-sha">{c.sha}</code> {c.subject}
              </div>
            )}
            <CommitFiles c={c} />
          </div>
        ))}
        {files.length > 3 && <ul className="git-files">{files.map((f) => <li key={f}><span className="git-path">{f}</span></li>)}</ul>}
        {[...(op.refs ?? []), ...(push?.refs ?? [])].map((r) => (
          <div key={r} className="git-ref">
            {r}
          </div>
        ))}
        {[...(op.moves ?? []), ...(merge?.moves ?? [])].map((m, k) => (
          <div key={k} className="git-ref">
            {m}
          </div>
        ))}
      </div>
    ) : null;
}

/** One git operation: its summary line, and (folded) the files, commits, refs or HEAD moves behind it. */
function GitOpRow({ op, merge, push, state }: { op: GitOp; merge?: GitOp; push?: GitOp; state: 'running' | 'error' | 'done' }) {
  const commits = op.commits ?? [];
  const one = commits.length === 1 ? commits[0]! : null;
  const madeCommit = /^(commit|merge|pull|cherry-pick|revert|rebase|am)$/.test(op.sub);
  // A commit-making op that finished in a failed command without a commit showing up most likely didn't happen.
  const failed = state === 'error' && madeCommit && op.commits !== undefined && commits.length === 0 && !op.moves?.length;
  const files = op.files ?? [];
  const body = opBody(op, merge, push);
  const summary = (
    <>
      <span className="git-icon" aria-hidden>
        ⎇
      </span>
      <span className="edit-verb">{op.verb}
        {merge ? ' & merged' : ''}
        {push ? ` & ${push.verb.toLowerCase()}` : ''}</span>
      {one ? (
        <>
          <code className="git-sha">{one.sha}</code>
          <span className="git-subject">{one.subject}</span>
          {commitStat(one)}
        </>
      ) : (
        <>
          {commits.length > 1 && <span className="git-subject">{commits.length} commits</span>}
          {op.detail && <span className="edit-name">{op.detail}</span>}
          {files.length > 0 && <span className="edit-name">{fileList(files)}</span>}
          {op.refs?.length === 1 && <span className="edit-dir">{op.refs[0]}</span>}
        </>
      )}
      {push?.refs?.length === 1 && <span className="edit-dir">{push.refs[0]}</span>}
      {merge ? (
        <span className="edit-dir">
          {shortDir(op.dir)} → {shortDir(merge.dir)}
          {merge.detail?.includes('fast-forward') ? ' (fast-forward)' : ''}
        </span>
      ) : (
        <span className="edit-dir">{shortDir(op.dir)}</span>
      )}
      {failed && <span className="edit-stat"><span className="del">didn't happen</span></span>}
    </>
  );
  const [open, setOpen] = useState(false);
  const shownCommit = commits[0];
  return body ? (
    <>
      <Row className={`git-card ${state}`} title={op.dir} onOpen={() => setOpen(true)}>
        {summary}
      </Row>
      {open && (
        <Modal className={shownCommit ? 'git-modal fg-modal' : 'git-modal'} head={summary} onClose={() => setOpen(false)}>
          <OpDetail op={op} merge={merge} push={push} body={body} />
        </Modal>
      )}
    </>
  ) : (
    <div className={`edit-card git-card plain ${state}`}>
      <div className="git-summary" title={op.dir}>
        {summary}
      </div>
    </div>
  );
}

/** A commit followed straight away by a merge (commit on the branch, merge it into main) and/or a push reads as one action. */
function rows(ops: GitOp[]): Array<{ op: GitOp; merge?: GitOp; push?: GitOp }> {
  const out: Array<{ op: GitOp; merge?: GitOp; push?: GitOp }> = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.sub === 'commit' && (op.commits === undefined || op.commits.length > 0)) {
      let merge: GitOp | undefined;
      let push: GitOp | undefined;
      if (ops[i + 1]?.sub === 'merge' && !/^Aborted/.test(ops[i + 1]!.verb)) merge = ops[++i];
      if (ops[i + 1]?.sub === 'push' && !/^Deleted/.test(ops[i + 1]!.verb)) push = ops[++i];
      out.push({ op, merge, push });
    } else out.push({ op });
  }
  return out;
}

type GitRow = { op: GitOp; merge?: GitOp; push?: GitOp };

const rowVerb = (r: GitRow) => `${r.op.verb}${r.merge ? ' & merged' : ''}${r.push ? ` & ${r.push.verb.toLowerCase()}` : ''}`;

/** A one-line gist of a row for the group's picker: the commit, else what the op named. */
function rowGist(r: GitRow): string {
  const c = r.op.commits?.[0];
  if (c) return `${r.op.commits!.length > 1 ? `${r.op.commits!.length} commits` : c.subject}`;
  return r.op.detail || (r.op.files?.length ? fileList(r.op.files) : '') || r.op.refs?.[0] || r.push?.refs?.[0] || '';
}

/** Several git actions in a row as one card: a summary of what happened, and a dialog that steps through each action. */
function GitGroup({ rows: rs, state }: { rows: GitRow[]; state: 'running' | 'error' | 'done' }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const verbs = rs.map(rowVerb);
  const shown = verbs.length <= 3 ? verbs : [...verbs.slice(0, 3), `+${verbs.length - 3} more`];
  const dirs = [...new Set(rs.map((r) => shortDir(r.op.dir)))];
  const summary = (
    <>
      <span className="git-icon" aria-hidden>
        ⎇
      </span>
      <span className="edit-verb">Git</span>
      <span className="git-subject">{shown.map((v, k) => (k === 0 ? v : v.toLowerCase())).join(', ')}</span>
      <span className="edit-stat">
        <span className="edit-lines">{rs.length} actions</span>
      </span>
      <span className="edit-dir">{dirs.length === 1 ? dirs[0] : `${dirs.length} repos`}</span>
    </>
  );
  const r = rs[Math.min(sel, rs.length - 1)]!;
  const hasCommits = rs.some((x) => x.op.commits?.length);
  return (
    <>
      <Row className={`git-card ${state}`} title={rs[0]!.op.dir} onOpen={() => setOpen(true)}>
        {summary}
      </Row>
      {open && (
        <Modal className={hasCommits ? 'git-modal fg-modal' : 'git-modal'} head={summary} onClose={() => setOpen(false)}>
          <div className="git-modal-col">
            <div className="git-modal-top">
              {rs.map((x, k) => (
                <button key={k} type="button" className={`git-pick${x === r ? ' sel' : ''}`} onClick={() => setSel(k)}>
                  <b>{rowVerb(x)}</b> {rowGist(x)}
                </button>
              ))}
            </div>
            <OpDetail key={sel} op={r.op} merge={r.merge} push={r.push} body={opBody(r.op, r.merge, r.push) ?? <div className="edit-dir modal-empty">{rowGist(r) || 'Nothing more to show.'}</div>} />
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * The git operations of one or more Bash calls in a row (commits with their files, staging, removals, pushes, merges…), surfaced
 * in the log instead of folded into "⋯ N steps". One line per op; ones with more to show open it in a modal.
 */
export function GitCard({ ops, state }: { ops: GitOp[]; state: 'running' | 'error' | 'done' }) {
  const rs = rows(ops);
  return (
    <div className="git-ops">
      {rs.length > 1 ? <GitGroup rows={rs} state={state} /> : rs.map((r, k) => <GitOpRow key={k} op={r.op} merge={r.merge} push={r.push} state={state} />)}
    </div>
  );
}
