import { useEffect, useRef, useState } from 'react';

/**
 * A title you can rename in place: a ✎ beside it (or double-click) swaps in a text box; Enter saves, Escape cancels.
 * `onSave` rejects to keep the box open (the caller shows the error); `allowEmpty` lets an empty name mean "reset".
 */
export function EditableTitle({
  value,
  onSave,
  label,
  allowEmpty = false,
  className,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  label: string;
  allowEmpty?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(value);
    setEditing(true);
  };
  const save = async () => {
    const next = draft.trim();
    if (next === value || (!next && !allowEmpty)) return setEditing(false);
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // The caller reported it; keep the box open.
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="editable-title-input"
        aria-label={label}
        value={draft}
        disabled={busy}
        maxLength={200}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <span className={`editable-title ${className ?? ''}`}>
      <span className="editable-title-text" onDoubleClick={start} title={value}>
        {value}
      </span>
      <button className="ghost icon editable-title-edit" aria-label={label} title={label} onClick={start}>
        ✎
      </button>
    </span>
  );
}
