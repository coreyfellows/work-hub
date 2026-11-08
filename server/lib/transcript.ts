import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A session's full conversation, from Claude's transcript (~/.claude/projects/<project>/<sessionId>.jsonl),
 * condensed for scanning: your messages, Claude's replies, and one line per tool call with its result.
 * The terminal (`claude logs`) only holds the current screen; this is the history behind it.
 * Files are read incrementally: each call only parses lines appended since the last one.
 *
 * The core only builds the plain entries (messages, tool calls with their results, AskUserQuestion forms, which
 * session status needs). Everything feature-specific (file edits, git operations, `!` runs, the menagerie host…)
 * comes from transcript enrichers (`addEnricher`), which add their fields to the entries as records are read.
 */

/** One response's token usage as Claude's transcript records it. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface HistoryEntry {
  i: number;
  /** tool_use id (tool entries) */
  id?: string;
  at: string | null;
  /** `notice`: something Claude Code showed that is neither of you talking (`notice` says what: an away summary). */
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text?: string;
  /** Notice entries: what kind (the recap Claude Code writes when you come back after a while). */
  notice?: 'away-summary';
  tool?: string;
  summary?: string;
  result?: string;
  isError?: boolean;
  /** Tool entries: when the result came back. */
  doneAt?: string | null;
  /** Assistant entries: a narration line (a thinking block the terminal shows), not a reply's text. */
  narration?: boolean;
  /** You sent this while Claude was mid-turn (it reached Claude at its next step). */
  queued?: boolean;
  /** AskUserQuestion calls: the questions, so the UI can render a form. */
  questions?: AskQuestion[];
  /** Edit / MultiEdit / Write / NotebookEdit calls: the change, so the log can show it inline. */
  edit?: FileEdit;
  /** Bash calls: the files the command changed (from the bash-snapshots plugin's git snapshots), one per file. */
  edits?: FileEdit[];
  /** Bash calls: the git operations in the command (commits with their files, staging, pushes…); the git-cards plugin's. */
  git?: GitOpsField;
  /** A command you ran yourself with `!` (bash mode): user entries, `text` is `! <command>`. */
  shell?: ShellRun;
  /**
   * A slash command Claude Code ran by itself (`/reload-plugins`, `/model`, `/cost`…): its output ('' when it printed
   * nothing). Set on the command's user entry when that output arrives; such a command gets no reply from Claude.
   */
  localOutput?: string;
}

/** The `git` field: opaque to the core (the git-cards plugin writes it and narrows it to its own `GitOp[]`). */
export type GitOpsField = object[];

/** A `!` command you ran in the session; its output arrives as a separate transcript record. */
export interface ShellRun {
  command: string;
  /** stdout then stderr, ANSI stripped and capped; undefined until the output record arrives. */
  output?: string;
  /** Anything on stderr (the exit code isn't recorded). */
  stderr?: boolean;
}

/** One change a session made to a file through Edit / MultiEdit / Write / NotebookEdit. */
export interface FileEdit {
  path: string;
  tool: string;
  at: string | null;
  /** Edit / MultiEdit: replaced text and its replacement (each capped). */
  hunks?: Array<{ old: string; new: string }>;
  /** Write: the new content (capped) and its line count. */
  content?: string;
  lines?: number;
  /** Write / Bash: the file didn't exist before (shown as the file itself, not a diff). Write: known once it has a result. */
  created?: boolean;
}

/**
 * Something Claude Code showed beside the conversation: hook feedback (a Stop hook that sent Claude back to work, a hook's
 * error or message) and task notifications (a background command or subagent finished). Kept apart from the entries so
 * the conversation views never draw them; `readNotices` lists them.
 */
export interface TranscriptNotice {
  /** Position in the session's notices. */
  i: number;
  at: string | null;
  kind: 'hook' | 'task';
  /** `blocked`: a hook stopped Claude and sent it back to work; `error`: a hook or task failed. */
  level: 'info' | 'error' | 'blocked';
  /** One line: the hook (`Stop`, `PostToolUse:Edit`) or the task's summary. */
  title: string;
  /** The hook's message or output, or the task's result (capped). */
  text?: string;
}

interface Cache {
  sessionId: string;
  path: string;
  offset: number;
  partial: string;
  entries: HistoryEntry[];
  notices: TranscriptNotice[];
  /** Tool calls' own `description` input (Bash's), by tool_use id, until their result arrives. */
  toolDescs: Map<string, string>;
  /** Background tasks calls started (a shell's `backgroundTaskId`, an async agent's `agentId`), by task id. */
  taskInfo: Map<string, BackgroundTaskInfo>;
  toolIndex: Map<string, number>;
  /** Usage per API response (message id), since a response spans several transcript lines. */
  usage: Map<string, { model: string; usage: Usage }>;
  /** Each enricher's own state for this session (by enricher id). */
  states: Map<string, unknown>;
}

/**
 * Adds fields to transcript entries as the core condenses a session's transcript. Every hook runs for every session,
 * in registration order, and each enricher keeps its own per-session `state` (from `init`, reset when the transcript is
 * rewritten). Fields an enricher returns are merged onto the entry, so keep them distinct from other enrichers'.
 */
export interface TranscriptEnricher<S = unknown> {
  id: string;
  init?(sessionId: string): S;
  /**
   * A raw transcript record (every line, sidechains and metadata included), before the core looks at it. `push` appends
   * an entry (its `i` is set for you); `at` is the record's timestamp. Return true to say it was consumed (the core and
   * later enrichers then skip it).
   */
  onRecord?(rec: unknown, h: { entries: HistoryEntry[]; push(e: HistoryEntry): void; state: S; at: string | null }): boolean | void;
  /** A tool call the core just made an entry for (not yet in `entries`); `raw` is the whole transcript record (e.g. its `cwd`). */
  onToolUse?(entry: HistoryEntry, tool: { name: string; input: unknown; raw: unknown }, state: S): Partial<HistoryEntry> | void;
  /** A tool call's result arrived (already on `entry.result`, clipped; `text` is the whole result, trimmed). */
  onToolResult?(entry: HistoryEntry, result: { text: string; isError: boolean }, state: S): Partial<HistoryEntry> | void;
  /** Async follow-up after each read (e.g. reading a reflog once a call has its result); true = something changed. */
  resolve?(sessionId: string, entries: HistoryEntry[], state: S): Promise<boolean>;
}

// Methods are checked bivariantly, so an enricher of any state type fits here.
const enrichers: Array<{ e: TranscriptEnricher; owner: string }> = [];

/** Add an enricher (`owner`: the plugin registering it, for `removeEnrichers`; 'core' for the core's own). */
export function addEnricher<S>(e: TranscriptEnricher<S>, owner = 'core'): void {
  enrichers.push({ e: e as TranscriptEnricher, owner });
  // Sessions read before this (plugins load after the first sessions poll) are re-read with it.
  caches.clear();
}

/** Drop every enricher `owner` added (e.g. a plugin that failed half-way through registering). */
export function removeEnrichers(owner: string): void {
  const before = enrichers.length;
  for (let i = enrichers.length - 1; i >= 0; i--) if (enrichers[i].owner === owner) enrichers.splice(i, 1);
  if (enrichers.length !== before) caches.clear();
}

function stateOf(c: Cache, e: TranscriptEnricher): unknown {
  if (!c.states.has(e.id)) c.states.set(e.id, e.init?.(c.sessionId));
  return c.states.get(e.id);
}

/** The menagerie host the transcript last named; `at` = the entry count when it was seen. */
export interface HistoryHost {
  name: string;
  at: number;
}
/** The enricher whose state holds `{ host: HistoryHost | null }`, which `readHistory` returns as `host`. */
export const HOST_ENRICHER_ID = 'host';

const PROJECTS = join(homedir(), '.claude', 'projects');
const caches = new Map<string, Cache>();
const MAX_RESULT = 1200;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const transcriptPaths = new Map<string, string>();

export async function findTranscript(sessionId: string): Promise<string | null> {
  const known = transcriptPaths.get(sessionId);
  if (known) return known;
  for (const dir of await readdir(PROJECTS).catch(() => [] as string[])) {
    const p = join(PROJECTS, dir, `${sessionId}.jsonl`);
    if (await stat(p).then(() => true, () => false)) {
      transcriptPaths.set(sessionId, p);
      return p;
    }
  }
  return null;
}

const TAIL_BYTES = 1024 * 1024;
const activityCache = new Map<string, { mtimeMs: number; size: number; at: number | null }>();

/**
 * When Claude last added a message to the session (ms): the timestamp of the transcript's last assistant
 * entry. The file's mtime isn't used because metadata entries (titles, cost state, mode…) are appended
 * after the fact and would make a long-dead session look recent. Null if the last 1MB has no assistant entry.
 */
export async function lastActivity(sessionId: string): Promise<number | null> {
  const path = await findTranscript(sessionId);
  if (!path) return null;
  try {
    const st = await stat(path);
    const hit = activityCache.get(sessionId);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.at;
    const len = Math.min(st.size, TAIL_BYTES);
    const fh = await open(path, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    const lines = text.split('\n');
    if (len < st.size) lines.shift(); // first line is probably cut off
    let at: number | null = null;
    for (let i = lines.length - 1; i >= 0 && at == null; i--) {
      const l = lines[i];
      if (!l.includes('"type":"assistant"')) continue;
      try {
        const e = JSON.parse(l) as { type?: string; timestamp?: string };
        const t = e.type === 'assistant' && e.timestamp ? Date.parse(e.timestamp) : NaN;
        if (Number.isFinite(t)) at = t;
      } catch {
        /* partial line */
      }
    }
    activityCache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, at });
    return at;
  } catch {
    transcriptPaths.delete(sessionId);
    activityCache.delete(sessionId);
    return null;
  }
}

/** A short description of a tool call from its input. */
export function summarise(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const pick =
    s('command') || s('file_path') || s('pattern') || s('description') || s('skill') || s('url') || s('query') || s('prompt') || s('tool_name');
  const text = pick || JSON.stringify(input);
  return clip(text.replace(/\s+/g, ' ').trim(), 240) + (name === 'Bash' && s('description') && pick !== s('description') ? `  # ${s('description')}` : '');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * A thinking block Claude Code shows in the terminal: the short progress lines ("I've drafted the plan…") some models
 * write as narration. They're recorded as `thinking` blocks, told apart from real (hidden) reasoning only by the
 * `narration` tag inside the block's signature (a protobuf, base64; the tag sits in its first few dozen bytes).
 * Reasoning is usually recorded empty; the rare reasoning that has text is tagged `thinking` and stays hidden.
 */
function isNarration(b: Record<string, unknown>): boolean {
  if (b.type !== 'thinking' || typeof b.thinking !== 'string' || !b.thinking.trim() || typeof b.signature !== 'string') return false;
  return Buffer.from(b.signature.slice(0, 96), 'base64').includes('narration');
}

const MAX_NOTICE = 4000;
const tag = (t: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(t)?.[1]?.trim() ?? '';

/** A slash command you typed (`<command-name>/x</command-name>…<command-args>…`), as you typed it; null otherwise. */
export function slashCommand(t: string): string | null {
  if (!/^\s*<command-(name|message)>/.test(t)) return null;
  const name = tag(t, 'command-name');
  if (!name.startsWith('/')) return null;
  const args = tag(t, 'command-args');
  return args ? `${name} ${args}` : name;
}

/** A `<task-notification>` turn (a background command or subagent finished) as a notice; null for anything else. */
function taskNotice(t: string): Omit<TranscriptNotice, 'i' | 'at'> | null {
  if (!/^\s*<task-notification>/.test(t)) return null;
  const summary = tag(t, 'summary');
  if (!summary) return null; // e.g. the mod hot-reload note, which isn't a task
  const result = tag(t, 'result');
  return { kind: 'task', level: tag(t, 'status') === 'failed' ? 'error' : 'info', title: summary, text: result ? clip(result, MAX_NOTICE) : undefined };
}

/** A hook attachment Claude Code shows (blocking error, non-blocking error, system message) as a notice; null otherwise. */
function hookNotice(a: Record<string, unknown>): Omit<TranscriptNotice, 'i' | 'at'> | null {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const hook = str(a.hookName) || str(a.hookEvent) || 'hook';
  if (a.type === 'hook_blocking_error') {
    const b = a.blockingError as { blockingError?: unknown } | undefined;
    return { kind: 'hook', level: 'blocked', title: hook, text: clip(str(b?.blockingError), MAX_NOTICE) || undefined };
  }
  if (a.type === 'hook_non_blocking_error') {
    const out = str(a.stderr).replace(/^Failed with non-blocking status code:\s*/, '') || str(a.stdout);
    return { kind: 'hook', level: 'error', title: hook, text: clip(out, MAX_NOTICE) || undefined };
  }
  if (a.type === 'hook_system_message' && str(a.content)) return { kind: 'hook', level: 'info', title: hook, text: clip(str(a.content), MAX_NOTICE) };
  return null;
}

/** Harness-injected user turns (reminders, notifications, command echoes) aren't things you typed. */
const isNoise = (t: string) => /^\s*<(system-reminder|task-notification|cross-session-message|command-|local-command|bash-|user-prompt-submit)/.test(t);

function ingest(c: Cache, line: string): void {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  const at = typeof r.timestamp === 'string' ? r.timestamp : null;
  const pushRaw = (e: HistoryEntry) => {
    e.i = c.entries.length;
    c.entries.push(e);
  };
  for (const { e } of enrichers) {
    if (e.onRecord?.(r, { entries: c.entries, push: pushRaw, state: stateOf(c, e), at }) === true) return;
  }
  const notice = (n: Omit<TranscriptNotice, 'i' | 'at'>): void => {
    c.notices.push({ i: c.notices.length, at, ...n });
  };
  // A message you typed while Claude was working is recorded as an attachment, not a user message.
  const att = r.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (!r.isSidechain && r.type === 'attachment' && att) {
    const n = hookNotice(att as Record<string, unknown>) ?? (att.type === 'queued_command' && typeof att.prompt === 'string' ? taskNotice(att.prompt) : null);
    if (n) return notice(n);
  }
  // A slash command Claude Code ran itself prints its output as a system record (older versions: a user turn) and gets
  // no reply: put the output on the command's entry, so nothing waits for Claude.
  const localOut = (t: string) => {
    const last = c.entries[c.entries.length - 1];
    if (last?.kind !== 'user' || !last.text?.startsWith('/') || last.localOutput !== undefined) return;
    const out = [tag(t, 'local-command-stdout'), tag(t, 'local-command-stderr')].filter(Boolean).join('\n');
    last.localOutput = clip(out.replace(/\x1b\[[0-9;]*m/g, ''), MAX_NOTICE);
  };
  if (!r.isSidechain && r.type === 'system' && r.subtype === 'local_command' && typeof r.content === 'string') {
    localOut(r.content);
    return;
  }
  if (!r.isSidechain && r.type === 'system' && r.subtype === 'away_summary' && typeof r.content === 'string' && r.content.trim()) {
    const text = r.content.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
    c.entries.push({ i: c.entries.length, at, kind: 'notice', notice: 'away-summary', text });
    return;
  }
  if (!r.isSidechain && r.type === 'attachment' && att?.type === 'queued_command' && typeof att.prompt === 'string' && !isNoise(att.prompt)) {
    c.entries.push({ i: c.entries.length, at, kind: 'user', text: att.prompt, queued: true });
    return;
  }
  if (r.isSidechain || (r.type !== 'user' && r.type !== 'assistant')) return;
  const msg = (r.message ?? {}) as { content?: unknown };
  const push = (e: Omit<HistoryEntry, 'i' | 'at'>) => c.entries.push({ i: c.entries.length, at, ...e });

  if (r.type === 'user') {
    if (r.isMeta) return;
    // Your own turn, unless it's a slash command (shown as you typed it) or a task notification (a notice).
    const userText = (t: string) => {
      const cmd = slashCommand(t);
      if (cmd) return push({ kind: 'user', text: cmd });
      const n = taskNotice(t);
      if (n) return notice(n);
      if (/^\s*<local-command-std(out|err)>/.test(t)) return localOut(t);
      if (!isNoise(t)) push({ kind: 'user', text: t });
    };
    if (typeof msg.content === 'string') {
      userText(msg.content);
      return;
    }
    for (const b of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
      if (b.type === 'text' && typeof b.text === 'string') userText(b.text);
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const desc = c.toolDescs.get(b.tool_use_id);
        c.toolDescs.delete(b.tool_use_id);
        const tur = (r.toolUseResult ?? {}) as { backgroundTaskId?: unknown; agentId?: unknown; isAsync?: unknown; description?: unknown; outputFile?: unknown };
        const task = typeof tur.backgroundTaskId === 'string' ? tur.backgroundTaskId : tur.isAsync === true && typeof tur.agentId === 'string' ? tur.agentId : null;
        if (task) {
          // A shell names its output file in the result text; an async agent's is a link to its own transcript.
          const out = typeof tur.outputFile === 'string' ? tur.outputFile : /Output is being written to: (\S+\.output)/.exec(resultText(b.content))?.[1];
          const description = desc ?? (typeof tur.description === 'string' ? tur.description : undefined);
          c.taskInfo.set(task, { ...(description ? { description } : {}), ...(out ? { outputFile: out } : {}) });
        }
        const idx = c.toolIndex.get(b.tool_use_id);
        if (idx !== undefined) {
          const entry = c.entries[idx];
          const text = resultText(b.content).trim();
          entry.result = clip(text, MAX_RESULT);
          entry.isError = b.is_error === true;
          entry.doneAt = at;
          for (const { e } of enrichers) {
            const extra = e.onToolResult?.(entry, { text, isError: entry.isError }, stateOf(c, e));
            if (extra) Object.assign(entry, extra);
          }
        }
      }
    }
    return;
  }

  const am = msg as { id?: unknown; model?: unknown; usage?: Usage };
  if (typeof am.id === 'string' && am.usage) c.usage.set(am.id, { model: String(am.model ?? ''), usage: am.usage });

  for (const b of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) push({ kind: 'assistant', text: b.text });
    if (isNarration(b)) push({ kind: 'assistant', text: (b.thinking as string).trim(), narration: true });
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      const input = (b.input ?? {}) as Record<string, unknown>;
      const questions = b.name === 'AskUserQuestion' && Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : undefined;
      const entry: HistoryEntry = {
        i: c.entries.length,
        at,
        kind: 'tool',
        tool: b.name,
        id: typeof b.id === 'string' ? b.id : undefined,
        summary: questions ? questions.map((q) => q.question).join(' · ') : summarise(b.name, input),
        questions,
      };
      for (const { e } of enrichers) {
        const extra = e.onToolUse?.(entry, { name: b.name, input, raw: r }, stateOf(c, e));
        if (extra) Object.assign(entry, extra);
      }
      c.entries.push(entry);
      if (typeof b.id === 'string') c.toolIndex.set(b.id, c.entries.length - 1);
      if (typeof b.id === 'string' && typeof input.description === 'string' && input.description.trim()) c.toolDescs.set(b.id, input.description.trim());
    }
  }
}

/**
 * Reads in progress, per session. Callers overlap (the claude source's openQuestion and lastActivity, history polls),
 * and the offset only moves after awaits, so without this each would ingest the same new lines: duplicate entries,
 * with a tool result landing only on the last copy (an answered question stayed open in the UI).
 */
const reading = new Map<string, Promise<Cache | null>>();

async function load(sessionId: string): Promise<Cache | null> {
  const prev = reading.get(sessionId);
  const run = (prev ? prev.catch(() => null) : Promise.resolve(null)).then(() => readNew(sessionId));
  reading.set(sessionId, run);
  let c: Cache | null;
  try {
    c = await run;
  } finally {
    if (reading.get(sessionId) === run) reading.delete(sessionId);
  }
  if (!c) return null;
  const cache = c;
  await Promise.all(
    enrichers.map(({ e }) =>
      e.resolve?.(sessionId, cache.entries, stateOf(cache, e)).catch((err: unknown) => {
        console.error(`transcript enricher ${e.id}:`, err);
        return false;
      }),
    ),
  );
  return c;
}

/** Ingests whatever was appended since the last read. Only ever one at a time per session (`load`). */
async function readNew(sessionId: string): Promise<Cache | null> {
  let c = caches.get(sessionId);
  if (!c) {
    const path = await findTranscript(sessionId);
    if (!path) return null;
    c = { sessionId, path, offset: 0, partial: '', entries: [], notices: [], toolDescs: new Map(), taskInfo: new Map(), toolIndex: new Map(), usage: new Map(), states: new Map() };
    caches.set(sessionId, c);
  }
  const size = (await stat(c.path)).size;
  if (size < c.offset) {
    // Rewritten (e.g. compacted): start over.
    Object.assign(c, { offset: 0, partial: '', entries: [], notices: [], toolDescs: new Map(), taskInfo: new Map(), toolIndex: new Map(), usage: new Map(), states: new Map() });
  }
  if (size > c.offset) {
    const fh = await open(c.path, 'r');
    try {
      const buf = Buffer.alloc(size - c.offset);
      await fh.read(buf, 0, buf.length, c.offset);
      c.offset = size;
      const lines = (c.partial + buf.toString('utf8')).split('\n');
      c.partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) ingest(c, line);
    } finally {
      await fh.close();
    }
  }
  return c;
}

/**
 * A session's condensed entries and its enrichers' state, read up to date (null if there's no transcript). For
 * enrichers' own lookups (e.g. a `!` run's full output, which only its enricher keeps).
 */
export async function transcriptState(sessionId: string): Promise<{ entries: HistoryEntry[]; state<S>(enricherId: string): S | undefined } | null> {
  const c = await load(sessionId).catch(() => null);
  if (!c) return null;
  return { entries: c.entries, state: <S>(id: string) => c.states.get(id) as S | undefined };
}

/**
 * A page of history. `before`: entries before this index (scrolling up). `after`: entries from this
 * index on (polling; callers re-ask a little before their last index to pick up late tool results).
 * Neither: the latest `limit`.
 */
export async function readHistory(
  sessionId: string,
  opts: { before?: number; after?: number; limit?: number },
): Promise<{ entries: HistoryEntry[]; start: number; total: number; host: HistoryHost | null; noticeCount: number } | null> {
  const c = await load(sessionId);
  if (!c) return null;
  const total = c.entries.length;
  const limit = Math.min(Math.max(opts.limit ?? 150, 1), 500);
  let start: number;
  let end: number;
  if (opts.after !== undefined) {
    start = Math.max(0, Math.min(opts.after, total));
    end = total;
  } else {
    end = Math.min(opts.before ?? total, total);
    start = Math.max(0, end - limit);
  }
  // The resident host is kept by the `host` enricher; the page needs it even when no entry in range shows it.
  const host = (c.states.get(HOST_ENRICHER_ID) as { host?: HistoryHost | null } | undefined)?.host ?? null;
  return { entries: c.entries.slice(start, end), start, total, host, noticeCount: c.notices.length };
}

/** The session's notices (hook feedback, task notifications), oldest first: the latest `limit` (default 200), or null. */
export async function readNotices(sessionId: string, limit = 200): Promise<{ notices: TranscriptNotice[]; total: number } | null> {
  const c = await load(sessionId).catch(() => null);
  if (!c) return null;
  return { notices: c.notices.slice(-Math.min(Math.max(limit, 1), 1000)), total: c.notices.length };
}

/** The AskUserQuestion call `toolUseId` if it's still unanswered (no result yet), else null. */
export async function pendingQuestion(sessionId: string, toolUseId: string): Promise<HistoryEntry | null> {
  const c = await load(sessionId);
  const idx = c?.toolIndex.get(toolUseId);
  if (!c || idx === undefined) return null;
  const e = c.entries[idx];
  return e.questions && e.result === undefined ? e : null;
}

/** The session's newest AskUserQuestion that has no answer yet (Claude is waiting on you), or null. */
export async function openQuestion(sessionId: string): Promise<HistoryEntry | null> {
  const c = await load(sessionId).catch(() => null);
  if (!c) return null;
  for (let i = c.entries.length - 1; i >= 0; i--) {
    const e = c.entries[i];
    if (e.questions) return e.result === undefined ? e : null;
    if (e.kind === 'user') return null; // you've spoken since; nothing pending
  }
  return null;
}

/** A background task as the call that started it recorded it. */
export interface BackgroundTaskInfo {
  /** The call's `description` (what it's for). */
  description?: string;
  /** Where its output goes: a shell's text file, or an agent's transcript (JSONL). */
  outputFile?: string;
}

/** The background tasks the session started (task id → what the transcript says about it), or null if unreadable. */
export async function backgroundTasks(sessionId: string): Promise<Map<string, BackgroundTaskInfo> | null> {
  const c = await load(sessionId).catch(() => null);
  return c ? c.taskInfo : null;
}

/** Every response's model and token usage (one per assistant message id), or null if the transcript can't be read. */
export async function sessionUsage(sessionId: string): Promise<Array<{ model: string; usage: Usage }> | null> {
  const c = await load(sessionId).catch(() => null);
  return c ? [...c.usage.values()] : null;
}

/** Every recorded file change (Edit/Write tools, and Bash via snapshots), oldest first, or null if the transcript can't be read. */
export async function sessionEdits(sessionId: string): Promise<FileEdit[] | null> {
  const c = await load(sessionId).catch(() => null);
  return c ? allEdits(c.entries) : null;
}

/**
 * Every file change on the entries (an edit tool's `edit`, a command's `edits`), oldest first. Edit-tool changes are in
 * call order; once a command's changes are known everything is sorted by time (stable).
 */
function allEdits(entries: HistoryEntry[]): FileEdit[] {
  const out: FileEdit[] = [];
  let fromCommands = false;
  for (const e of entries) {
    if (e.edit) out.push(e.edit);
    if (e.edits?.length) {
      out.push(...e.edits);
      fromCommands = true;
    }
  }
  if (fromCommands) out.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return out;
}

/** Where a session's transcript lives and the model it last answered with (for handoffs). */
export async function sessionMeta(sessionId: string): Promise<{ path: string | null; model: string | null }> {
  const path = await findTranscript(sessionId);
  const c = await load(sessionId).catch(() => null);
  const models = c ? [...c.usage.values()].map((u) => u.model).filter((m) => m.startsWith('claude-')) : [];
  return { path, model: models.at(-1) ?? null };
}
