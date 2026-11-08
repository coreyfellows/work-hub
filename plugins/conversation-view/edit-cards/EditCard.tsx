import { useState } from 'react';
import {
  buildTree,
  editStats,
  EditBody,
  EditSummary,
  FilesBrowser,
  Modal,
  netItem,
  Row,
  splitPath,
  type EditState as State,
  type FileEdit,
  type FileNode,
  type GroupItem,
} from '../../../plugin-api/web.ts';

/**
 * A file change Claude made, in the readable log (the terminal would show this diff; the log otherwise hides tool
 * work): a one-line row; clicking it opens the change in a modal, so the chat never shifts.
 */
export function EditCard({ edit, state }: { edit: FileEdit; state: State }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row className={state} title={edit.path} onOpen={() => setOpen(true)}>
        <EditSummary edit={edit} state={state} />
      </Row>
      {open && (
        <Modal head={<EditSummary edit={edit} state={state} />} onClose={() => setOpen(false)}>
          <EditBody edit={edit} state={state} />
        </Modal>
      )}
    </>
  );
}

const NAMES_SHOWN = 3;

/**
 * Several file changes in a row, condensed to one row: "Modified N files" with a few names. Clicking it (or a name)
 * opens a modal with the file tree beside the selected file's net change.
 */
export function FileGroupCard({ items }: { items: GroupItem[] }) {
  const byPath = new Map<string, GroupItem[]>();
  for (const it of items) byPath.set(it.edit.path, [...(byPath.get(it.edit.path) ?? []), it]);
  const files: FileNode[] = [...byPath].map(([path, its]) => {
    const net = netItem(its);
    const s = net ? editStats(net.edit) : { added: 0, removed: 0, created: false };
    return { path, edits: its, net, ...s, failed: !net };
  });
  const created = files.filter((f) => f.created).length;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const running = items.some((it) => it.state === 'running');
  const verb =
    files.length === 1 ? `Edited ${items.length} times` : created === files.length ? `Created ${files.length} files` : created ? `Changed ${files.length} files` : `Modified ${files.length} files`;
  const { base } = buildTree(files);
  const [open, setOpen] = useState<string | null>(null); // the selected file while the modal is up
  const shown = files.slice(0, NAMES_SHOWN);
  const stat = (
    <span className="edit-stat">
      {created > 0 && created < files.length && <span className="add">{created} new</span>}
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  );
  return (
    <>
      <Row className={`file-group ${running ? 'running' : 'done'}`} title={files.map((f) => f.path).join('\n')} onOpen={() => setOpen(files[0]!.path)}>
        <span className="edit-verb">{verb}</span>
        <span className="edit-name">
          {shown.map((f, k) => (
            <span key={f.path}>
              {k > 0 && ', '}
              <button
                type="button"
                className="ftree-jump"
                title={`Show ${f.path}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setOpen(f.path);
                }}
              >
                {f.path.split('/').pop()}
              </button>
            </span>
          ))}
          {files.length > NAMES_SHOWN && <span className="edit-more"> and {files.length - NAMES_SHOWN} more {files.length - NAMES_SHOWN === 1 ? 'file' : 'files'}…</span>}
        </span>
        {stat}
      </Row>
      {open !== null && (
        <Modal
          className="fg-modal"
          onClose={() => setOpen(null)}
          head={
            <>
              <span className="edit-verb">{verb}</span>
              {base && <span className="edit-dir">{splitPath(`${base}/x`).dir}</span>}
              {stat}
            </>
          }
        >
          <FilesBrowser files={files} selected={open} onSelect={setOpen} />
        </Modal>
      )}
    </>
  );
}
