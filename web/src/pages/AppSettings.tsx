import { ApplyNow } from '../components/ApplyNow.tsx';
import { useState } from 'react';
import type { SettingField, SettingsPayload } from '../../../server/settings.ts';
import { post } from '../api.ts';
import { useToast } from '../components/Toast.tsx';

type Group = SettingsPayload['groups'][number];
type Edit = string | boolean | null;

/**
 * One group of app settings (the core's own, or a plugin's from its manifest) as a form. A field set by an env var or
 * plugins.json is shown but locked (those win); everything else saves to the app's database with Save, and "Reset"
 * puts the default back. Whatever reads a value per use applies it at once; a field marked `restart` says it needs one.
 */
export function SettingsGroupForm({ group, onSaved }: { group: Group; onSaved: (p: SettingsPayload) => void }) {
  const { show } = useToast();
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A field marked `restart` was saved: offer to apply it now.
  const [needsApply, setNeedsApply] = useState(false);
  const dirty = Object.keys(edits).length > 0;

  const set = (f: SettingField, v: Edit) =>
    setEdits((cur) => {
      const next = { ...cur };
      // Back to what's stored: not an edit any more.
      if (v === (f.source === 'app' ? f.value : undefined) && typeof v !== 'object') delete next[f.fullKey];
      else next[f.fullKey] = v;
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, string | number | boolean | null> = {};
      for (const f of group.fields) {
        if (!(f.fullKey in edits)) continue;
        const v = edits[f.fullKey];
        values[f.fullKey] = f.type === 'number' && typeof v === 'string' ? (v.trim() === '' ? null : Number(v)) : v;
      }
      onSaved(await post<SettingsPayload>('/api/settings', { values }));
      if (group.fields.some((f) => f.restart && f.fullKey in values)) setNeedsApply(true);
      setEdits({});
      show({ text: `${group.title} saved.` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {group.description && <div className="muted small-text">{group.description}</div>}
      {group.fields.map((f) => (
        <Field key={f.fullKey} f={f} edit={edits[f.fullKey]} set={(v) => set(f, v)} disabled={busy} />
      ))}
      <div className="menu-row">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="ghost" disabled={busy} onClick={() => setEdits({})}>
            Discard
          </button>
        )}
        {error && <span className="bad">{error}</span>}
        {needsApply && !dirty && <ApplyNow what="Saved." />}
      </div>
    </>
  );
}

function Field({ f, edit, set, disabled }: { f: SettingField; edit: Edit | undefined; set: (v: Edit) => void; disabled: boolean }) {
  const locked = f.source === 'env' || f.source === 'plugins.json';
  const cleared = edit === null;
  const shown = edit === undefined ? f.value : edit;
  const isDefault = cleared || (edit === undefined && f.source === 'default');
  const text = cleared ? '' : shown === undefined ? '' : String(shown);
  const placeholder = f.placeholder ?? (f.default !== undefined ? String(f.default) : '');
  const lock = locked ? (
    <div className="muted small-text">{f.source === 'env' ? `Set by the ${f.envName} environment variable.` : 'Set in plugins.json.'}</div>
  ) : null;

  const reset =
    !locked && !isDefault ? (
      <button className="ghost small" disabled={disabled} onClick={() => set(null)} title="Back to the default">
        Reset
      </button>
    ) : null;

  const head = (
    <>
      {f.label}
      {f.restart && <span className="muted small-text"> · needs a restart</span>}
    </>
  );

  if (f.type === 'boolean') {
    const on = cleared ? Boolean(f.default) : Boolean(shown);
    return (
      <div className="setting-field">
        <div className="menu-row">
          <label className="readable-toggle grow">
            <input type="checkbox" checked={on} disabled={disabled || locked} onChange={(e) => set(e.target.checked)} />
            <span>{head}</span>
          </label>
          {reset}
        </div>
        {f.description && <div className="muted small-text">{f.description}</div>}
        {lock}
      </div>
    );
  }

  return (
    <div className="setting-field">
      <div className="menu-row">
        <span className="grow">{head}</span>
        {reset}
      </div>
      {f.type === 'text' ? (
        <textarea rows={6} value={text} placeholder={placeholder} disabled={disabled || locked} spellCheck={false} onChange={(e) => set(e.target.value)} />
      ) : f.type === 'select' ? (
        <select value={cleared ? String(f.default ?? '') : String(shown ?? '')} disabled={disabled || locked} onChange={(e) => set(e.target.value)}>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={f.type === 'number' ? 'number' : 'text'}
          inputMode={f.type === 'number' ? 'decimal' : undefined}
          min={f.min}
          max={f.max}
          value={text}
          placeholder={placeholder}
          disabled={disabled || locked}
          spellCheck={false}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {f.description && <div className="muted small-text">{f.description}</div>}
      {lock}
    </div>
  );
}
