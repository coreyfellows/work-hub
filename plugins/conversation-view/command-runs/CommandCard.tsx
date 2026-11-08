import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, loadHighlightCode, Modal, post, SessionIdContext, TerminalRunContext, useLowData, type HistoryEntry } from '../../../plugin-api/web.ts';
import { commandCandidates } from './shared/scriptPath.ts';
import type { CommandRun } from './types.ts';

/**
 * Commands Claude hands you to run yourself, written as a fenced block of one `! <command>` line (Claude Code's bash mode: the command runs
 * in the session's shell and its output lands in the conversation). Such a block in Claude's messages gets
 * Run and Copy (never in question forms: not wanted there): Run types it at the session's prompt via POST /api/sessions/:id/run,
 * queued until Claude is at its prompt; the run starts a turn, so Claude reads the output.
 */

/**
 * A fenced code block's text → its command, only when it's written to be run: exactly one line, starting at
 * column 0 with `!` (the format the global CLAUDE.md asks for). Anything else (inline code, several lines,
 * indented) is just code.
 */
export function bangCommand(block: string): string | null {
  const lines = block.replace(/\n+$/, '').split('\n');
  if (lines.length !== 1) return null;
  const m = /^!\s*(\S.*)$/.exec(lines[0]!.trimEnd());
  return m ? m[1]!.trim() : null;
}


/** Every `!` command already run in this session: command → latest run's time and output. */
export const ShellRunsContext = createContext<Map<string, HistoryEntry>>(new Map());

export function shellRuns(entries: HistoryEntry[]): Map<string, HistoryEntry> {
  const m = new Map<string, HistoryEntry>();
  for (const e of entries) if (e.shell) m.set(e.shell.command, e);
  return m;
}

/**
 * The session's Run records from the server (command_runs: latest per command), so a card's queued / ran state
 * survives switching tabs, workspaces or reloading. The shell log-card's Wrap owns it (useCommandRuns) and provides it here.
 */
export const CommandRunsContext = createContext<{ runs: Map<string, CommandRun>; set: (runs: CommandRun[]) => void; reload: () => Promise<void> }>({
  runs: new Map(),
  set: () => {},
  reload: async () => {},
});

/** Loads the session's runs, re-fetching when `tick` changes (e.g. new history) and every 3s while any is in flight. */
export function useCommandRuns(sessionId: string, tick: unknown) {
  const [list, setList] = useState<CommandRun[]>([]);
  const load = useCallback(async () => {
    const r = await get<{ runs: CommandRun[] }>(`/api/sessions/${sessionId}/run`).catch(() => null);
    if (r) setList(r.runs);
  }, [sessionId]);
  useEffect(() => {
    setList([]);
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  // Queued, or running in a terminal (its output is saved when the script exits).
  const active = list.some((r) => r.status === 'queued' || (r.via === 'terminal' && !r.outputAt));
  // Quick while a run is waiting for its turn, so "queued" flips to "running" as soon as it's typed in; stretched in Low data.
  const lowData = useLowData();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => !document.hidden && void load(), lowData ? 10000 : 1500);
    return () => clearInterval(t);
  }, [active, load, lowData]);
  return { runs: new Map(list.map((r) => [r.command, r])), set: setList, reload: load };
}

const OPTIMISTIC_ID = -1;
function optimisticRun(sessionId: string, command: string): CommandRun {
  return {
    id: OPTIMISTIC_ID, sessionId, workspaceId: null, command, status: 'queued', queuedAt: new Date().toISOString(), doneAt: null,
    error: null, outputAt: null, outputLines: null, stderr: false, via: 'session', exitCode: null, termId: null,
  };
}

/**
 * Chat bubble for a `!` run that hasn't reached the transcript yet (sending, queued, or typed in and awaiting its output):
 * the script header, with a spinner where the output will be. The real "You ran" card replaces it when the output lands.
 */
export function PendingRuns({ stage }: { stage: 'started' | 'waiting' }) {
  const { runs } = useContext(CommandRunsContext);
  const shells = useContext(ShellRunsContext);
  const pending = [...runs.values()].filter((r) => {
    if (r.via !== 'session') return false;
    // Typed in = it began a turn (above Claude's working bubble); sending or queued = still waiting for its turn.
    if (r.status === 'queued') return stage === 'waiting';
    if (stage === 'waiting') return false;
    if (r.status !== 'ran' || !r.doneAt) return false;
    const shell = shells.get(r.command);
    return !(shell?.at && Date.parse(shell.at) >= Date.parse(r.doneAt) - 5000) && Date.now() - Date.parse(r.doneAt) < 5 * 60_000;
  });
  if (!pending.length) return null;
  return (
    <>
      {pending.map((r) => {
        const what = r.id === OPTIMISTIC_ID ? 'sending…' : r.status === 'queued' ? 'queued' : 'running…';
        return (
          <div key={`run-${r.command}`} className="msg-group user">
            <div className="r-who">You · {what}</div>
            <div className="bubble">
              <div className="bubble-part">
                <div className="shell-card pending">
                  <div className="shell-head">
                    <span className="cmd-bang" aria-hidden>
                      !
                    </span>
                    <code className="cmd-text">{r.command}</code>
                  </div>
                  <div className="shell-out shell-wait">
                    <span className="cmd-spin big" aria-hidden />
                    <span>
                      {r.id === OPTIMISTIC_ID ? 'Sending…' : r.status === 'queued' ? 'Waiting for Claude’s prompt…' : 'Running… output appears here'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function useRunCommand(command: string) {
  const sessionId = useContext(SessionIdContext);
  const { runs, set } = useContext(CommandRunsContext);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (body: Record<string, unknown>) => {
    if (!sessionId) return;
    setSending(true);
    setError(null);
    // Show it at once (a queued row, so the chat gets its pending bubble); the server's answer replaces it.
    const before = [...runs.values()];
    if (!body.cancel) set([...before.filter((r) => r.command !== command.trim()), optimisticRun(sessionId, command.trim())]);
    try {
      const r = await post<{ runs: CommandRun[] }>(`/api/sessions/${sessionId}/run`, { command, ...body });
      set(r.runs);
    } catch (e) {
      set(before);
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return { sessionId, record: runs.get(command), sending, error, run: () => call({}), cancel: () => call({ cancel: true }) };
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard permission: nothing to do */
    }
  };
  return { copied, copy };
}

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A command to run, as a card: the command, Run (types it in the session) and Copy (`! <command>`). */
export function CommandCard({ command }: { command: string }) {
  const { sessionId, record, sending, error, run, cancel } = useRunCommand(command);
  const { copied, copy } = useCopy(`! ${command}`);
  const shell = useContext(ShellRunsContext).get(command);
  const queued = record?.status === 'queued';
  // Ran: the Run record (typed in) or the transcript (it ran, maybe pasted by hand), whichever is newer.
  const ranAt = [record?.status === 'ran' ? record.doneAt : null, shell?.at].filter(Boolean).sort().pop() ?? null;
  // Typed in, but its output isn't in the transcript yet.
  const inTerm = record?.via === 'terminal';
  const running =
    record?.status === 'ran' && !!record.doneAt && (inTerm ? !record.outputAt : !(shell?.at && Date.parse(shell.at) >= Date.parse(record.doneAt) - 5000));
  const failed = !queued && (record?.status === 'failed' || record?.status === 'expired') && !(shell?.at && record.doneAt && shell.at > record.doneAt);
  const state = sending ? 'sending' : error || failed ? 'error' : queued ? 'queued' : running ? 'running' : ranAt ? 'ran' : 'idle';
  const [viewing, setViewing] = useState(false);
  const inTerminal = useContext(TerminalRunContext);
  const { reload } = useContext(CommandRunsContext);
  const [termState, setTermState] = useState<'idle' | 'opening' | string>('idle');
  const openTerminal = async () => {
    if (!inTerminal || !sessionId) return;
    setTermState('opening');
    try {
      await inTerminal(command, sessionId);
      setTermState('idle');
      void reload();
    } catch (e) {
      setTermState((e as Error).message || "couldn't open a terminal");
    }
  };
  return (
    <div className={`cmd-card ${state}`}>
      {viewing && sessionId && record && (
        <OutputModal command={command} url={`/api/sessions/${sessionId}/run/${record.id}/output`} onClose={() => setViewing(false)} />
      )}
      <div className="cmd-line">
        <span className="cmd-bang" aria-hidden>
          !
        </span>
        <code className="cmd-text">{command}</code>
      </div>
      <div className="cmd-actions">
        {sessionId && (
          <button
            type="button"
            className="cmd-run"
            onClick={() => void run()}
            disabled={sending || queued}
            title="Run it in this session's shell (like typing it with ! at Claude's prompt); Claude reads the output"
          >
            {sending ? 'Starting…' : ranAt ? '▶ Run again' : '▶ Run'}
          </button>
        )}
        {inTerminal && sessionId && (
          <button
            type="button"
            className="cmd-term"
            onClick={() => void openTerminal()}
            disabled={termState === 'opening'}
            title="Open a new workspace terminal and run it there (interactive). Its output is saved when it exits, but Claude doesn't see it"
          >
            {termState === 'opening' ? 'Opening…' : '▶ Terminal'}
          </button>
        )}
        <button type="button" className="cmd-copy" onClick={() => void copy()} title="Copy as a ! command to paste into a terminal Claude">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <ScriptButton command={command} />
        {sessionId && record?.outputAt && (
          <button type="button" className="cmd-view" onClick={() => setViewing(true)} title="Open this run's recorded output">
            View output{record.outputLines ? ` (${record.outputLines} ${record.outputLines === 1 ? 'line' : 'lines'})` : ''}
          </button>
        )}
        <span className="cmd-status">
          {termState !== 'idle' && termState !== 'opening' ? (
            <span className="cmd-error">Terminal: {termState}</span>
          ) : sending ? (
            <>
              <span className="cmd-spin" aria-hidden /> Sending to Claude…
            </>
          ) : error ? (
            <span className="cmd-error">{error}</span>
          ) : queued ? (
            <>
              <span className="cmd-spin" aria-hidden /> Queued {ago(record!.queuedAt)}: runs when Claude is at its prompt ·{' '}
              <button type="button" className="link" onClick={() => void cancel()}>
                cancel
              </button>
            </>
          ) : running ? (
            <>
              <span className="cmd-spin" aria-hidden />{' '}
              {inTerm ? 'Running in a terminal… its output is saved when it exits' : 'Running… Claude will read the output'}
            </>
          ) : inTerm && record?.outputAt ? (
            <>
              Ran in a terminal {ago(record.outputAt)}
              {record.exitCode !== null && (
                <span className={record.exitCode ? 'cmd-error' : ''}> · exit {record.exitCode}</span>
              )}
              {record.error && <span className="cmd-error"> · {record.error}</span>}
            </>
          ) : failed ? (
            <span className="cmd-error">
              {record!.status === 'expired' ? 'Queued too long; not run' : `Didn't run: ${record!.error ?? 'unknown error'}`}
            </span>
          ) : ranAt ? (
            <>Ran {ago(ranAt)}</>
          ) : record?.status === 'cancelled' ? (
            'Cancelled'
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** A `!` command you ran (bash mode), with its output: collapsed past a few lines. */
export function ShellCard({ e }: { e: HistoryEntry }) {
  const sh = e.shell!;
  const lines = sh.output?.split('\n') ?? [];
  const long = lines.length > 12;
  const [open, setOpen] = useState(false);
  const { copied, copy } = useCopy(`! ${sh.command}`);
  const sessionId = useContext(SessionIdContext);
  const [viewing, setViewing] = useState(false);
  return (
    <div className={`shell-card${sh.stderr ? ' err' : ''}`}>
      {viewing && sessionId && (
        <OutputModal command={sh.command} url={`/api/sessions/${sessionId}/shell-output?i=${e.i}`} onClose={() => setViewing(false)} />
      )}
      <div className="shell-head">
        <span className="cmd-bang" aria-hidden>
          !
        </span>
        <code className="cmd-text">{sh.command}</code>
        {sessionId && sh.output && (
          <button type="button" className="cmd-view" onClick={() => setViewing(true)} title="Open the output, syntax highlighted">
            Open
          </button>
        )}
        <button type="button" className="cmd-copy" onClick={() => void copy()} title="Copy as a ! command">
          {copied ? '✓' : 'Copy'}
        </button>
        <ScriptButton command={sh.command} />
      </div>
      {sh.output === undefined ? (
        <pre className="shell-out muted">running…</pre>
      ) : sh.output ? (
        <>
          <pre className="shell-out">{long && !open ? lines.slice(-12).join('\n') : sh.output}</pre>
          {long && (
            <button type="button" className="link shell-more" onClick={() => setOpen((o) => !o)}>
              {open ? 'Show less' : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      ) : (
        <pre className="shell-out muted">(no output)</pre>
      )}
    </div>
  );
}


interface OutputData {
  command: string;
  output: string | null;
  stderr: boolean;
  /** Run records: when it was typed in / when the output landed; transcript runs: when it ran. */
  doneAt?: string | null;
  outputAt?: string | null;
  at?: string | null;
  via?: 'session' | 'terminal';
  exitCode?: number | null;
}

/** A run's full output in a modal: line numbers, syntax highlighting (JSON, diffs, YAML… by content), Copy. */
function OutputModal({ command, url, onClose }: { command: string; url: string; onClose: () => void }) {
  const [data, setData] = useState<OutputData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hl, setHl] = useState<{ html: string; language: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    get<OutputData>(url)
      .then((d) => {
        if (!alive) return;
        setData(d);
        if (d.output) void loadHighlightCode().then((m) => alive && setHl(m.highlightOutput(d.output!))).catch(() => {});
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [url]);
  const output = data?.output ?? '';
  const { copied, copy } = useCopy(output);
  const when = data?.outputAt ?? data?.at ?? data?.doneAt;
  const n = output ? output.split('\n').length : 0;
  return (
    <Modal
      className="out-modal"
      onClose={onClose}
      head={
        <span className="out-head">
          <span className="cmd-bang">!</span> <code className="cmd-text">{command}</code>
        </span>
      }
    >
      <div className="out-meta">
        {when && <span>Ran {ago(when)}</span>}
        {data && <span>{n} {n === 1 ? 'line' : 'lines'}</span>}
        {hl?.language && <span>{hl.language}</span>}
        {data?.via === 'terminal' && <span>in a terminal</span>}
        {data?.exitCode != null && <span className={data.exitCode ? 'cmd-error' : ''}>exit {data.exitCode}</span>}
        {data?.stderr && <span className="cmd-error">wrote to stderr</span>}
        {output && (
          <button type="button" className="cmd-copy" onClick={() => void copy()}>
            {copied ? 'Copied ✓' : 'Copy output'}
          </button>
        )}
      </div>
      {error ? (
        <div className="error">{error}</div>
      ) : !data ? (
        <div className="muted out-empty">Loading…</div>
      ) : !output ? (
        <div className="muted out-empty">{data.output === null ? 'No output recorded yet.' : '(no output)'}</div>
      ) : (
        <div className="out-view">
          <pre className="out-ln" aria-hidden>
            {Array.from({ length: n }, (_, i) => i + 1).join('\n')}
          </pre>
          {hl ? <pre className="out-src hljs" dangerouslySetInnerHTML={{ __html: hl.html }} /> : <pre className="out-src">{output}</pre>}
        </div>
      )}
    </Modal>
  );
}

interface ScriptData {
  path: string;
  content: string;
  bytes: number;
  mtime: string;
}

/** "View script": for a command that runs a script file, open the file's source in a modal (only when the command names a path-like file). */
function ScriptButton({ command }: { command: string }) {
  const sessionId = useContext(SessionIdContext);
  const [open, setOpen] = useState(false);
  if (!sessionId || commandCandidates(command).length === 0) return null;
  return (
    <>
      <button type="button" className="cmd-view" onClick={() => setOpen(true)} title="Show the script this command runs">
        View script
      </button>
      {open && <ScriptModal command={command} sessionId={sessionId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScriptModal({ command, sessionId, onClose }: { command: string; sessionId: string; onClose: () => void }) {
  const [data, setData] = useState<ScriptData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    get<ScriptData>(`/api/sessions/${sessionId}/script?command=${encodeURIComponent(command)}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        void loadHighlightCode().then((m) => alive && setHtml(m.highlightLines(d.path, d.content))).catch(() => {});
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [sessionId, command]);
  const { copied, copy } = useCopy(data?.content ?? '');
  const lines = data ? data.content.replace(/\n$/, '').split('\n') : [];
  return (
    <Modal
      className="out-modal"
      onClose={onClose}
      head={
        <span className="out-head">
          <span className="cmd-bang">!</span> <code className="cmd-text">{data ? data.path.replace(/^\/Users\/[^/]+/, '~') : command}</code>
        </span>
      }
    >
      <div className="out-meta">
        {data && (
          <>
            <span>
              {lines.length} {lines.length === 1 ? 'line' : 'lines'}
            </span>
            <span>modified {ago(data.mtime)}</span>
            <button type="button" className="cmd-copy" onClick={() => void copy()}>
              {copied ? 'Copied ✓' : 'Copy script'}
            </button>
          </>
        )}
      </div>
      {error ? (
        <div className="error">{error}</div>
      ) : !data ? (
        <div className="muted out-empty">Loading…</div>
      ) : (
        <div className="out-view">
          <pre className="out-ln" aria-hidden>
            {lines.map((_, i) => i + 1).join('\n')}
          </pre>
          {html ? (
            <pre className="out-src hljs" dangerouslySetInnerHTML={{ __html: html.join('\n') }} />
          ) : (
            <pre className="out-src">{lines.join('\n')}</pre>
          )}
        </div>
      )}
    </Modal>
  );
}
