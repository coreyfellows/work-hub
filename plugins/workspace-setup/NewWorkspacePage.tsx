import { useState } from 'react';
import { Link, navigate, post, type Workspace } from '../../plugin-api/web.ts';

/** Start work from a ticket key or a prompt: creates the workspace and dispatches the setup agent. */
export function NewWorkspacePage() {
  const [mode, setMode] = useState<'ticket' | 'prompt'>('ticket');
  const [ticket, setTicket] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ workspace: Workspace }>('/api/workspaces', mode === 'ticket' ? { ticket, prompt } : { prompt });
      navigate(`/workspaces/${r.workspace.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <Link to="/" className="back">
        ← Workspaces
      </Link>
      <h2>New workspace</h2>
      <div className="form">
        <div className="seg">
          <button className={mode === 'ticket' ? 'on' : ''} onClick={() => setMode('ticket')}>
            Ticket
          </button>
          <button className={mode === 'prompt' ? 'on' : ''} onClick={() => setMode('prompt')}>
            Prompt
          </button>
        </div>
        {mode === 'ticket' && (
          <input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="Ticket key, e.g. TKT-14700" autoFocus />
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={mode === 'ticket' ? 'Extra context (optional)' : 'What do you want to work on?'}
          rows={5}
          autoFocus={mode === 'prompt'}
        />
        <button className="primary" onClick={start} disabled={busy || (mode === 'ticket' ? !ticket.trim() : !prompt.trim())}>
          {busy ? 'Starting…' : 'Start'}
        </button>
        {error && <div className="error">{error}</div>}
        <p className="muted small-text">
          Starts an Opus setup agent that picks the repos, creates and records worktrees, writes a plan, then waits for you.
        </p>
      </div>
    </div>
  );
}
