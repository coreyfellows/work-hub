import { useEffect, useRef, useState } from 'react';
import { ConfirmPopover, Link, Menu, post, useToast } from '../../plugin-api/web.ts';
import { API, startGen, useGenJobs, useKnown } from './castJobs.ts';
import { placeholders, type Placeholder } from './editorState.ts';
import type { Part } from './generate.ts';
import { HostAvatar } from './HostAvatar.tsx';
import { hostVars, reloadHosts, useFunHosts, useHostsLoaded } from './menagerie.ts';
import type { FunHost } from './types.ts';

const MAX_ROWS = 6;
const DISMISSED_KEY = 'wh.menagerieDismissedJobs';
const PART_LABEL: Record<Part, string> = { portrait: 'Reroll portrait', lines: 'Reroll lines', motion: 'Reroll animations', all: 'Recreate' };
const PART_DOING: Record<Part, string> = { portrait: 'portrait', lines: 'lines', motion: 'animations', all: 'everything' };

type Kind = 'play' | 'inspired';
interface Row {
  named: string;
  kind: Kind;
}

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Calls the cast's JSON routes the guard accepts for writes (DELETE included). */
async function send(method: 'DELETE', path: string): Promise<void> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

/** Up to six "a character you like" rows, each played as themselves or as someone new inspired by them. */
function SetupForm({ max = MAX_ROWS, onDone }: { max?: number; onDone?: () => void }) {
  const [rows, setRows] = useState<Row[]>([{ named: '', kind: 'play' }]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const filled = rows.filter((r) => r.named.trim());
  const set = (i: number, r: Partial<Row>) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const submit = async () => {
    setBusy(true);
    try {
      for (const r of filled) await startGen({ named: r.named.trim(), kind: r.kind });
      setRows([{ named: '', kind: 'play' }]);
      onDone?.();
    } catch (err) {
      toast.show({ text: `Couldn't start: ${(err as Error).message}`, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="fun-setup"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {rows.map((r, i) => (
        <div key={i} className="fun-setup-row">
          <input
            value={r.named}
            maxLength={60}
            placeholder="A character you like"
            aria-label="A character you like"
            onChange={(e) => set(i, { named: e.target.value })}
          />
          <div className="fun-seg" role="radiogroup" aria-label="How to use them">
            {(['play', 'inspired'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={r.kind === k} className={r.kind === k ? 'on' : ''} onClick={() => set(i, { kind: k })}>
                {k === 'play' ? 'Play them' : 'Invent someone like them'}
              </button>
            ))}
          </div>
          {rows.length > 1 && (
            <button type="button" className="icon ghost" aria-label="Remove this row" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="fun-setup-actions">
        {rows.length < max && (
          <button type="button" className="ghost" onClick={() => setRows((cur) => [...cur, { named: '', kind: 'play' }])}>
            + Another
          </button>
        )}
        <button type="submit" className="primary" disabled={busy || !filled.length}>
          Generate
        </button>
      </div>
      <div className="muted small-text">Each one is a separate Opus run (a minute or two, spends tokens). They show up here as they finish.</div>
    </form>
  );
}

/** A reroll's optional note ("make him grumpier"), in a small popover by the card. */
function RerollPopover({ host, part, onClose }: { host: FunHost; part: Part; onClose: () => void }) {
  const [note, setNote] = useState('');
  const toast = useToast();
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => box.current?.querySelector('input')?.focus(), []);
  const go = async () => {
    try {
      await startGen({ id: host.id, part, feedback: note.trim() || undefined, named: host.origin.named, kind: host.origin.kind });
      toast.show({ text: `Rerolling ${host.name}'s ${PART_DOING[part]}…` });
      onClose();
    } catch (err) {
      toast.show({ text: `Couldn't start: ${(err as Error).message}`, kind: 'error' });
    }
  };
  return (
    <form
      ref={box}
      className="fun-reroll"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <b>{PART_LABEL[part]}</b>
      <input value={note} maxLength={300} placeholder="A note for this version (optional)" aria-label="A note for this version" onChange={(e) => setNote(e.target.value)} />
      <div className="fun-setup-actions">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Go
        </button>
      </div>
    </form>
  );
}

function CastCard({ host, job }: { host: FunHost; job?: Placeholder }) {
  const [part, setPart] = useState<Part | null>(null);
  const toast = useToast();
  const remove = async () => {
    try {
      await send('DELETE', `${API}/characters/${encodeURIComponent(host.id)}`);
      await reloadHosts();
      toast.show({ text: `${host.name} moved out.` });
    } catch (err) {
      toast.show({ text: `Couldn't remove: ${(err as Error).message}`, kind: 'error' });
    }
  };
  const undo = async () => {
    try {
      await post(`${API}/characters/${encodeURIComponent(host.id)}/undo`);
      await reloadHosts();
    } catch (err) {
      toast.show({ text: `Couldn't undo: ${(err as Error).message}`, kind: 'error' });
    }
  };
  const running = job?.status === 'running';
  return (
    <div className={`fun-card fun-${host.id}`} style={hostVars(host)}>
      <div className="fun-card-head">
        <HostAvatar host={host} size={64} />
        <div className="fun-words">
          <div className="fun-name">
            {host.badge && <span className="fun-badge">{host.badge}</span>}
            {host.name} {host.emoji}
          </div>
          <div className="muted small-text">
            {host.origin.kind === 'play' ? `Playing ${host.origin.named}` : `Inspired by ${host.origin.named}`}
            {host.rare ? ' · rare guest' : ''}
          </div>
        </div>
      </div>
      <ul className="fun-card-asks">
        {host.asks.slice(0, 2).map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      {running && <div className="fun-card-job muted small-text">Rerolling {PART_DOING[job!.part]}… {job!.detail ?? ''}</div>}
      {job?.status === 'failed' && <div className="fun-card-job bad small-text">Reroll failed: {job.error}</div>}
      <div className="fun-card-actions">
        <Menu
          trigger="Reroll ▾"
          ariaLabel={`Reroll ${host.name}`}
          items={(['portrait', 'lines', 'motion', 'all'] as const).map((p) => ({ label: PART_LABEL[p], onSelect: () => setPart(p), disabled: running }))}
        />
        {host.canUndo && !running && (
          <button className="ghost" onClick={() => void undo()}>
            Undo last reroll
          </button>
        )}
        <ConfirmPopover
          message={`Remove ${host.name} from your cast?`}
          confirmLabel="Remove"
          onConfirm={remove}
          className="ghost danger"
          disabled={running}
          title={running ? 'Wait for the reroll to finish' : undefined}
        >
          Remove
        </ConfirmPopover>
      </div>
      {part && <RerollPopover host={host} part={part} onClose={() => setPart(null)} />}
    </div>
  );
}

function PlaceholderCard({ p, onDismiss }: { p: Placeholder; onDismiss: () => void }) {
  const toast = useToast();
  const retry = async (kind: Kind) => {
    try {
      await startGen({ named: p.named, kind });
      onDismiss();
    } catch (err) {
      toast.show({ text: `Couldn't start: ${(err as Error).message}`, kind: 'error' });
    }
  };
  return (
    <div className={`fun-card fun-placeholder${p.status === 'running' ? ' pulsing' : ''}`}>
      <div className="fun-card-head">
        <span className="fun-avatar emoji" style={{ width: 64, height: 64, fontSize: 30 }} aria-hidden>
          {p.status === 'running' ? '✏️' : '💤'}
        </span>
        <div className="fun-words">
          <div className="fun-name">{p.named}</div>
          <div className="muted small-text">{p.kind === 'play' ? 'Playing them' : 'Someone like them'}</div>
        </div>
      </div>
      {p.status === 'running' ? (
        <div className="muted small-text">{p.detail ?? 'Starting…'}</div>
      ) : (
        <>
          <div className="bad small-text">{p.declined ? `The model wouldn't play them: ${p.error?.replace(/^declined:\s*/, '')}` : `Failed: ${p.error}`}</div>
          <div className="fun-card-actions">
            {p.declined && p.kind === 'play' ? (
              <button className="primary" onClick={() => void retry('inspired')}>
                Invent someone like them
              </button>
            ) : (
              <button onClick={() => void retry(p.kind)}>Retry</button>
            )}
            <button className="ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * What an import would bring in, before it does: each character's name and voice. The voice goes into the prompt of
 * every session the app starts, so an imported cast is trusted text.
 */
function ImportPreview({ file }: { file: unknown }) {
  const list = (file && typeof file === 'object' && Array.isArray((file as { characters?: unknown }).characters)
    ? (file as { characters: unknown[] }).characters
    : []) as { name?: unknown; emoji?: unknown; voice?: unknown }[];
  return (
    <div className="fun-import-preview">
      <div className="small-text">
        {list.length ? `${list.length} character${list.length === 1 ? '' : 's'} in this file.` : 'No characters in this file.'} Each one's voice goes
        into the prompt of every session the app starts: import only casts you trust.
      </div>
      <ul>
        {list.slice(0, 20).map((c, i) => (
          <li key={i}>
            <b>
              {typeof c.emoji === 'string' ? c.emoji : '?'} {typeof c.name === 'string' ? c.name : '(no name)'}
            </b>
            : <span className="muted">{typeof c.voice === 'string' ? c.voice : '(no voice)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImportExport() {
  const toast = useToast();
  const [file, setFile] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = async (f: File | undefined) => {
    if (!f) return;
    try {
      setFile(JSON.parse(await f.text()));
    } catch {
      toast.show({ text: "That file isn't a cast file (not JSON).", kind: 'error' });
    }
  };
  const run = async (mode: 'replace' | 'merge') => {
    try {
      const r = await post<{ added: string[]; skipped: { id?: string; reason: string }[] }>(`${API}/import`, { cast: file, mode });
      await reloadHosts();
      toast.show({ text: `Imported ${r.added.length}${r.skipped.length ? `, skipped ${r.skipped.length} (${r.skipped.map((s) => s.id ?? '?').join(', ')})` : ''}.` });
    } catch (err) {
      toast.show({ text: `Couldn't import: ${(err as Error).message}`, kind: 'error' });
    } finally {
      setFile(null);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="fun-io">
      <a className="button ghost" href={`${API}/export`} download="menagerie-cast.json">
        Export
      </a>
      <label className="button ghost">
        Import…
        <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => void load(e.target.files?.[0])} />
      </label>
      {file !== null && (
        <>
          <ImportPreview file={file} />
          <button onClick={() => void run('merge')}>Add to my cast</button>
          <ConfirmPopover message="Replace your whole cast with this file?" confirmLabel="Replace" onConfirm={() => run('replace')} className="danger">
            Replace my cast
          </ConfirmPopover>
          <button className="ghost" onClick={() => setFile(null)}>
            Cancel
          </button>
        </>
      )}
      <Link to="/settings/faces">See every face animation →</Link>
    </div>
  );
}

/** The plugin's settings page section: the setup form (no cast yet) or a card per character, plus import/export. */
export function CastEditor() {
  const hosts = useFunHosts();
  const loaded = useHostsLoaded();
  const jobs = useGenJobs();
  const known = useKnown();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [adding, setAdding] = useState(false);
  const all = placeholders({ jobs, known, dismissed });
  const fresh = all.filter((p) => !p.id);
  const dismiss = (jobId: string) =>
    setDismissed((cur) => {
      const next = new Set([...cur, jobId]);
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-50)));
      } catch {
        /* private mode */
      }
      return next;
    });
  if (!loaded) return <div className="muted">Loading…</div>;
  const empty = !hosts.length && !fresh.length;
  return (
    <div className="fun-editor">
      {empty ? (
        <>
          <p>Name a few characters you like. Each becomes a resident host: a portrait, a voice, lines and animations of their own, drawn and written for you.</p>
          <SetupForm />
        </>
      ) : (
        <>
          <div className="fun-cards">
            {hosts.map((h) => (
              <CastCard key={h.id} host={h} job={all.find((p) => p.id === h.id)} />
            ))}
            {fresh.map((p) => (
              <PlaceholderCard key={p.jobId} p={p} onDismiss={() => dismiss(p.jobId)} />
            ))}
          </div>
          {adding ? (
            <SetupForm max={1} onDone={() => setAdding(false)} />
          ) : (
            <button onClick={() => setAdding(true)}>+ Add a character</button>
          )}
        </>
      )}
      <ImportExport />
    </div>
  );
}
