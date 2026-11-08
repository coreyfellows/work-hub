import { useState } from 'react';
import { Modal, post, SESSION_MODELS, useToast, type Workspace } from '../../plugin-api/web.ts';

// "auto" lets the server rate the task's difficulty and pick (sessionPlan.ts).
const MODELS = ['auto', ...SESSION_MODELS] as const;

/** The tab strip's "New session" form, in a modal: starts the session as a job (`POST …/sessions/new`). */
export function NewSessionModal({ ws, onClose }: { ws: Workspace; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const { show: toast } = useToast();
  return (
    <Modal head="New session" className="modal-form" onClose={onClose}>
      <NewSessionBox
        ws={ws}
        busy={busy}
        onCancel={onClose}
        onStart={async (body) => {
          // The server starts it as a job (model and name picking take a while): the form closes at once and the
          // header tray follows it, with a link to the session when it's up.
          setBusy(true);
          try {
            await post(`/api/workspaces/${ws.id}/sessions/new`, body);
            onClose();
          } catch (e) {
            toast({ kind: 'error', text: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      />
    </Modal>
  );
}

/** Start a new session in this workspace: your prompt, plus (added by the server) what the workspace is about. */
function NewSessionBox({
  ws,
  busy,
  onStart,
  onCancel,
}: {
  ws: Workspace;
  busy: boolean;
  onStart: (body: { prompt: string; cwd: string; model: string; name: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState(ws.worktrees[0]?.path ?? '');
  const [model, setModel] = useState<string>('auto');
  const [name, setName] = useState('');
  return (
    <div className="handoff-box new-session-box">
      <textarea
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the new session do? It's also told what this workspace is about: ticket, plan, worktrees, links, note and earlier sessions."
        disabled={busy}
        autoFocus
      />
      <div className="new-session-fields">
        <label>
          <span className="muted small-text">Folder</span>
          <select value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={busy}>
            {ws.worktrees.map((t) => (
              <option key={t.id} value={t.path}>
                {t.repo.split('/')[1] ?? t.repo} @{t.branch ?? '?'}
              </option>
            ))}
            <option value="">~/worktrees (no repo)</option>
          </select>
        </label>
        <label>
          <span className="muted small-text">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m === 'auto' ? 'auto (by difficulty)' : m}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          <span className="muted small-text">Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="auto, from the task" disabled={busy} />
        </label>
      </div>
      <div className="handoff-actions">
        <button className="primary" disabled={busy || !prompt.trim()} onClick={() => void onStart({ prompt: prompt.trim(), cwd, model, name: name.trim() })}>
          {busy ? (model === 'auto' || !name.trim() ? 'Picking model and name…' : 'Starting…') : 'Start session'}
        </button>
        <button className="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
