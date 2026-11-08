import { useState } from 'react';
import { Modal, post, SESSION_MODELS, useToast, type Session } from '../../plugin-api/web.ts';
import { handoffDrafts, setBusy, useBusy } from './busy.ts';

/** The ⋯ menu's "Hand off": instructions and a model for the fresh session, then `POST …/handoff` (a job in the tray). */
export function HandoffDialog({ session, workspaceId, onClose }: { session: Session; sessionId: string; workspaceId?: string; onClose(): void }) {
  const id = session.sessionId;
  const draft = handoffDrafts.get(id);
  const [handoffNote, setNote] = useState(draft?.note ?? '');
  const [handoffModel, setModel] = useState(draft?.model ?? 'auto');
  const setHandoffNote = (note: string) => {
    setNote(note);
    handoffDrafts.set(id, { note, model: handoffModel });
  };
  const setHandoffModel = (model: string) => {
    setModel(model);
    handoffDrafts.set(id, { note: handoffNote, model });
  };
  const busy = useBusy(id) === 'handoff';
  const { show: toast } = useToast();
  const run = async (note: string, model: string): Promise<boolean> => {
    setBusy(id, 'handoff');
    try {
      // Runs as a job (a minute or two): the box closes at once and the header tray has the link to the new session.
      await post(`/api/workspaces/${workspaceId}/sessions/${id}/handoff`, { note, model });
      return true;
    } catch (e) {
      toast({ kind: 'error', text: (e as Error).message });
      return false;
    } finally {
      setBusy(id, null);
    }
  };
  return (
    <Modal head="Hand off" className="modal-form" onClose={onClose}>
      <div className="handoff-box">
        <textarea
          rows={3}
          value={handoffNote}
          onChange={(e) => setHandoffNote(e.target.value)}
          placeholder="Instructions for the new session (optional). Without any, it restates where things stand and waits for you."
          disabled={busy}
        />
        <div className="new-session-fields">
          <label>
            <span className="muted small-text">Model for the new session</span>
            <select value={handoffModel} onChange={(e) => setHandoffModel(e.target.value)} disabled={busy}>
              <option value="auto">auto (by difficulty)</option>
              <option value="same">same as this session</option>
              {SESSION_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="handoff-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(handoffNote.trim(), handoffModel).then((ok) => {
                // On failure keep the box and your text; the toast shows the error.
                if (!ok) return;
                handoffDrafts.set(id, { note: '', model: handoffModel });
                onClose();
              })
            }
          >
            {busy ? 'Handing off…' : 'Hand off'}
          </button>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <span className="muted small-text">
            Summarizes this session into a brief, starts a fresh session with it, then stops this one (`claude attach` still reopens it). Takes a minute or two.
          </span>
        </div>
      </div>
    </Modal>
  );
}
