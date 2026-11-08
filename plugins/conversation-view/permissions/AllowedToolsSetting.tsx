import { useEffect, useState } from 'react';
import { get, post, useToast } from '../../../plugin-api/web.ts';

interface Allowlist {
  rules: string[];
  defaults: string[];
  custom: boolean;
}

/**
 * Settings → Session permissions: the tools every session work-hub starts may use without stopping at a permission
 * prompt (Claude Code permission rules, one per line). Applies to sessions started after saving.
 */
export function AllowedToolsSetting() {
  const toast = useToast();
  const [data, setData] = useState<Allowlist | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (d: Allowlist) => {
    setData(d);
    setText(d.rules.join('\n'));
  };

  useEffect(() => {
    get<Allowlist>('/api/permissions/allowed-tools').then(apply, (e: Error) => setError(e.message));
  }, []);

  const save = async (body: { rules: string[] } | { reset: true }, done: string) => {
    const before = data;
    setBusy(true);
    setError(null);
    try {
      apply(await post<Allowlist>('/api/permissions/allowed-tools', body));
      toast.show({
        text: done,
        action: before ? { label: 'Undo', run: async () => apply(await post<Allowlist>('/api/permissions/allowed-tools', before.custom ? { rules: before.rules } : { reset: true })) } : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <div className="error">{error}</div> : <div className="muted">Loading…</div>;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const changed = lines.join('\n') !== data.rules.join('\n');

  return (
    <div className="allowlist">
      <div className="muted">
        Tools sessions started by work-hub may use without asking, as Claude Code permission rules, one per line
        (e.g. <code>Read</code>, <code>Bash(git log:*)</code>, <code>mcp__server__tool</code>). Anything else still asks, and
        you can answer from the Chat view. Applies to sessions started after you save.
      </div>
      <textarea
        className="allowlist-rules"
        value={text}
        spellCheck={false}
        rows={Math.min(Math.max(lines.length + 1, 6), 18)}
        onChange={(e) => setText(e.target.value)}
        aria-label="Allowed tools, one rule per line"
      />
      <div className="allowlist-actions">
        <button type="button" className="primary" disabled={!changed || busy} onClick={() => void save({ rules: lines }, 'Session permissions saved')}>
          Save
        </button>
        {changed && (
          <button type="button" className="ghost" disabled={busy} onClick={() => setText(data.rules.join('\n'))}>
            Discard changes
          </button>
        )}
        {data.custom && (
          <button type="button" className="ghost" disabled={busy} onClick={() => void save({ reset: true }, 'Session permissions back to the defaults')}>
            Reset to defaults
          </button>
        )}
        <span className="muted small-text">{data.custom ? 'Customised' : 'Defaults'} · {data.rules.length} rules</span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
