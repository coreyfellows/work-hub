import { useEffect, useState } from 'react';
import { ConfirmPopover, get, Link, navigate, type Workspace } from '../../plugin-api/web.ts';

interface VcsList {
  providers: Array<{ id: string; title: string; experimental: boolean }>;
  default: string;
}

/** git first, the other providers as registered, Plain folder last. */
const order = (id: string) => (id === 'git' ? 0 : id === 'folder' ? 2 : 1);

/** Start work from a ticket key or a prompt: creates the workspace and dispatches the setup agent (or, for a plain folder, a session in it). */
export function NewWorkspacePage() {
  const [mode, setMode] = useState<'ticket' | 'prompt'>('ticket');
  const [ticket, setTicket] = useState('');
  const [prompt, setPrompt] = useState('');
  const [vcs, setVcs] = useState('detect');
  const [folder, setFolder] = useState('');
  const [providers, setProviders] = useState<VcsList['providers'] | null>(null);
  const [vcsDefault, setVcsDefault] = useState('detect');
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasFolder = !!folder.trim();
  // One small (revalidated) request: the Source control choices, and Settings' default for the help line.
  useEffect(() => {
    get<VcsList>('/api/vcs').then(
      (r) => {
        setProviders([...r.providers].sort((a, b) => order(a.id) - order(b.id)));
        setVcsDefault(r.default);
      },
      () => setProviders([]), // the choice is optional: Detect still works
    );
  }, []);
  // What Start makes: a plain folder (given, chosen, or Settings' default under Detect), else the setup agent's workspace.
  const plain = hasFolder || vcs === 'folder' || (vcs === 'detect' && vcsDefault === 'folder');

  const start = async (confirmFolder = false) => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = mode === 'ticket' ? { ticket, prompt } : { prompt };
      if (vcs !== 'detect') body.vcs = vcs;
      if (hasFolder) body.folder = folder.trim();
      if (confirmFolder) body.confirmFolder = true;
      // Not `post`: a folder outside the roots answers 409 { needsConfirm }, which is a question, not an error.
      const res = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { workspace?: Workspace; error?: string; needsConfirm?: string };
      if (res.status === 409 && json.needsConfirm) {
        setNeedsConfirm(json.needsConfirm);
        setBusy(false);
        return;
      }
      if (!res.ok || !json.workspace) throw new Error(json.error ?? `HTTP ${res.status}`);
      navigate(`/workspaces/${json.workspace.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const ready = vcs === 'folder' ? hasFolder : hasFolder || (mode === 'ticket' ? !!ticket.trim() : !!prompt.trim());
  const pick = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setNeedsConfirm(null);
  };

  return (
    <div className="page narrow">
      <Link to="/" className="back">
        ← Workspaces
      </Link>
      <h2>New workspace</h2>
      <div className="form">
        <div className="seg">
          <button className={mode === 'ticket' ? 'on' : ''} onClick={() => pick(setMode)('ticket')}>
            Ticket
          </button>
          <button className={mode === 'prompt' ? 'on' : ''} onClick={() => pick(setMode)('prompt')}>
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
        <details className="nw-more">
          <summary>More options</summary>
          <label className="nw-field">
            <span>Source control</span>
            <select value={vcs} onChange={(e) => pick(setVcs)(e.target.value)}>
              <option value="detect">Detect</option>
              {(providers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {`${p.title}${p.experimental ? ' (experimental)' : ''}`}
                </option>
              ))}
            </select>
          </label>
          <label className="nw-field">
            <span>Folder</span>
            <input
              value={folder}
              onChange={(e) => pick(setFolder)(e.target.value)}
              placeholder="A name (under the plain workspaces folder) or a path"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        </details>
        <button className="primary" onClick={() => void start()} disabled={busy || !ready}>
          {busy ? 'Starting…' : 'Start'}
        </button>
        {needsConfirm && (
          <div className="nw-confirm">
            <span>
              <code>{needsConfirm}</code> is outside the worktrees and plain workspaces folders.
            </span>
            <ConfirmPopover message={`Let Claude sessions work in ${needsConfirm}?`} confirmLabel="Allow and start" onConfirm={() => start(true)} disabled={busy}>
              Allow…
            </ConfirmPopover>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <p className="muted small-text">
          {!plain
            ? 'Starts an Opus setup agent that picks the repos, creates and records worktrees, writes a plan, then waits for you.'
            : hasFolder || vcs === 'folder'
              ? 'Creates the folder if it is missing and starts a session in it, with your prompt as its task (no setup agent).'
              : 'Your default source control is Plain folder: creates a folder for this workspace in the plain workspaces folder and starts a session in it, with your prompt as its task (no setup agent).'}
        </p>
      </div>
    </div>
  );
}
