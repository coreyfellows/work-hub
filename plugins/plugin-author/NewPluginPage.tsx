import { useEffect, useState } from 'react';
import { get, Link, navigate, post, type Workspace } from '../../plugin-api/web.ts';
import { NAME_RE } from './name.ts';

interface CreateOptions {
  officialAvailable: boolean;
  folders: Array<{ path: string; usable: boolean; why?: string }>;
  taken: string[];
  configError?: string;
}

const NEW_FOLDER = '\u0000new';

/** Describe a plugin; Create makes a workspace whose Claude session builds it (POST /api/plugins/plugin-author/create). */
export function NewPluginPage() {
  const [opts, setOpts] = useState<CreateOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [official, setOfficial] = useState(false);
  const [defaultEnabled, setDefaultEnabled] = useState(true);
  const [folder, setFolder] = useState('');
  const [newPath, setNewPath] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<CreateOptions>('/api/plugins/plugin-author/options').then(
      (o) => {
        setOpts(o);
        // First usable folder of plugins, else a new folder.
        setFolder(o.folders.find((f) => f.usable)?.path ?? NEW_FOLDER);
      },
      (e) => setLoadError((e as Error).message),
    );
  }, []);

  const trimmed = name.trim();
  const nameError = !trimmed
    ? null
    : !NAME_RE.test(trimmed)
      ? 'Lowercase letters, digits and dashes, starting with a letter.'
      : trimmed === 'core' || opts?.taken.includes(trimmed)
        ? `"${trimmed}" is already taken.`
        : null;
  const destination = folder === NEW_FOLDER ? newPath.trim() : folder;
  const destError = official || !destination ? null : destination.startsWith('/') || /^[A-Za-z]:[\\/]/.test(destination) ? null : 'Use an absolute path.';
  const ready = !!opts && !!description.trim() && !nameError && !destError && (official || !!destination);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ workspace: Workspace }>('/api/plugins/plugin-author/create', {
        name: trimmed || undefined,
        official,
        ...(official ? { defaultEnabled } : { destination }),
        description,
      });
      navigate(`/workspaces/${r.workspace.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <Link to="/settings" className="back">
        ← Settings
      </Link>
      <h2>Create plugin</h2>
      {loadError && <div className="error">{loadError}</div>}
      {!opts && !loadError && <div className="muted">Loading…</div>}
      {opts && (
        <div className="pa-form">
          <label className="pa-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. standup (optional: the session picks one)" spellCheck={false} autoCapitalize="off" disabled={busy} />
            {nameError && <span className="bad small-text">{nameError}</span>}
          </label>

          <label className="pa-toggle">
            <input type="checkbox" checked={official} disabled={busy || !opts.officialAvailable} onChange={(e) => setOfficial(e.target.checked)} />
            <span>
              Official
              <div className="muted small-text">
                {opts.officialAvailable ? 'Added to the work-hub repo (plugins/<id>/) instead of a folder of your own.' : 'Only when work-hub runs from a git checkout; this one isn’t, so the plugin will be local.'}
              </div>
            </span>
          </label>
          {official && (
            <label className="pa-toggle pa-sub">
              <input type="checkbox" checked={defaultEnabled} disabled={busy} onChange={(e) => setDefaultEnabled(e.target.checked)} />
              <span>
                On by default
                <div className="muted small-text">On for everyone unless they switch it off.</div>
              </span>
            </label>
          )}

          {!official && (
            <label className="pa-field">
              <span>Destination</span>
              <select value={folder} onChange={(e) => setFolder(e.target.value)} disabled={busy}>
                {opts.folders.map((f) => (
                  <option key={f.path} value={f.path} disabled={!f.usable}>
                    {f.path}
                    {f.why ? ` (${f.why})` : ''}
                  </option>
                ))}
                <option value={NEW_FOLDER}>New folder…</option>
              </select>
              {folder === NEW_FOLDER && (
                <input className="pa-path" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/absolute/path/to/my-plugin" spellCheck={false} autoCapitalize="off" disabled={busy} />
              )}
              {opts.configError && <span className="bad small-text">{opts.configError}</span>}
              {destError && <span className="bad small-text">{destError}</span>}
              <span className="muted small-text">
                {folder === NEW_FOLDER ? 'The plugin’s own folder: new or empty. The session adds it to your local plugin folders.' : 'A folder of plugins: the plugin goes in a subfolder named after its id.'}
              </span>
            </label>
          )}

          <label className="pa-field">
            <span>What should it do?</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} placeholder="What it shows or does, where it appears, what it reads from…" disabled={busy} />
          </label>

          <div className="pa-actions">
            <button className="primary" onClick={() => void create()} disabled={busy || !ready}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          <p className="muted small-text">
            Creates a workspace with a work-hub worktree and a Claude session that builds the plugin there. Steer it from Chat; it asks before going live.
          </p>
        </div>
      )}
    </div>
  );
}
