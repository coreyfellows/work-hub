/**
 * Which new Claude Code features could apply to which plugins: each plugin's baseline (the Claude version it has been
 * looked at for), the headless prompt, and the deterministic filter over the model's answer. Pure, unit-tested.
 */
import { between, toMarkdown, type ChangelogEntry } from './changelog.ts';
import { compareVersions, maxVersion, newer } from './version.ts';

/** What's recorded locally for a plugin (table `claude_monitor_plugins`). */
export interface PluginRecord {
  pluginId: string;
  version: string;
  /** `seen`: first noticed at that version; `skipped`: the user passed on that version's suggestions; `updating`: an update session was started for it. */
  action: 'seen' | 'skipped' | 'updating';
  workspaceId: string | null;
  at: string;
}

/** A plugin the analysis may suggest changes to. */
export interface Candidate {
  id: string;
  title: string;
  kind: 'official' | 'local';
  dir: string;
  description: string;
  /** README text (cut), plus the first part of any feature READMEs in its subfolders. */
  readme: string;
  /** plugin.json `claudeVersion`: the Claude version an update session last brought it up to. */
  manifestVersion: string | null;
}

export interface Baseline {
  version: string | null;
  from: 'manifest' | 'skipped' | 'updating' | 'seen' | null;
}

/** The newest of the manifest's `claudeVersion` and the local record; only changes after it are suggested. */
export function baselineOf(manifestVersion: string | null, record: PluginRecord | undefined): Baseline {
  const v = maxVersion(manifestVersion, record?.version);
  if (!v) return { version: null, from: null };
  if (manifestVersion && compareVersions(manifestVersion, v) === 0 && !(record && newer(record.version, manifestVersion))) return { version: v, from: 'manifest' };
  return { version: v, from: record?.action ?? null };
}

export interface SuggestionItem {
  version: string;
  /** The changelog item, as written. */
  change: string;
  /** What the plugin could do with it. */
  idea: string;
}

export interface PluginSuggestion {
  plugin: string;
  title: string;
  kind: 'official' | 'local';
  /** The baseline it was compared from. */
  since: string | null;
  items: SuggestionItem[];
}

export interface Analysis {
  /** The installed Claude version the analysis covered changes up to. */
  version: string;
  at: string;
  suggestions: PluginSuggestion[];
  /** Plugins that had nothing newer than their baseline to look at. */
  upToDate: string[];
  costUsd: number | null;
  /** Older changelog sections left out to keep the prompt small. */
  dropped: number;
}

/** Per candidate, the entries newer than its baseline up to `target`; plugins with none are up to date. */
export function workList(cands: Candidate[], records: Map<string, PluginRecord>, entries: ChangelogEntry[], target: string) {
  const work: Array<{ cand: Candidate; since: string | null; entries: ChangelogEntry[] }> = [];
  const upToDate: string[] = [];
  for (const cand of cands) {
    const since = baselineOf(cand.manifestVersion, records.get(cand.id)).version;
    // No baseline at all would mean the whole history: the server records `seen` first, so this is only a guard.
    const es = since ? between(entries, since, target) : [];
    if (es.length) work.push({ cand, since, entries: es });
    else upToDate.push(cand.id);
  }
  return { work, upToDate };
}

/** The prompt for the headless run: the changes, then each plugin with the version it was last looked at for. */
export function analysisPrompt(work: ReturnType<typeof workList>['work'], maxChangelogChars = 120_000): { prompt: string; dropped: number } {
  // One changelog block covering every plugin's range (the oldest baseline's), newest first.
  const all = new Map<string, ChangelogEntry>();
  for (const w of work) for (const e of w.entries) all.set(e.version, e);
  const entries = [...all.values()].sort((a, b) => compareVersions(b.version, a.version));
  const { text, dropped } = toMarkdown(entries, maxChangelogChars);
  const plugins = work
    .map((w) =>
      [
        `### Plugin \`${w.cand.id}\` (${w.cand.kind}): ${w.cand.title}`,
        `Only consider changes in versions newer than ${w.since ?? 'any'}.`,
        ...(w.cand.description ? [`Description: ${w.cand.description}`] : []),
        '',
        w.cand.readme,
      ].join('\n'),
    )
    .join('\n\n');
  const prompt = [
    'You help maintain plugins for work-hub, a local web dashboard that drives Claude Code sessions (it lists sessions, shows their conversations, answers their questions and permission prompts, types into background jobs started with `claude --bg`, reads transcripts, starts headless `claude -p` runs, and links PRs and worktrees).',
    'Below are new Claude Code release notes, then each plugin with its README. For each plugin, pick the release-note items that the plugin should react to: a new capability it could use or show, a changed behaviour or format it depends on (transcripts, hooks, settings, CLI flags, `claude agents`, background jobs, slash commands, AskUserQuestion, permissions), or a fix that lets it drop a workaround. Leave out items that do not touch what the plugin does. Most plugins will have none; that is fine.',
    '',
    'Answer with JSON only, no prose, in exactly this shape:',
    '{"suggestions":[{"plugin":"<plugin id>","items":[{"version":"<x.y.z from the notes>","change":"<the release-note item, quoted>","idea":"<one or two sentences: what to change in this plugin>"}]}]}',
    'Use only plugin ids and versions that appear below. At most 6 items per plugin, the most useful first. Omit plugins with nothing.',
    '',
    '# Claude Code release notes',
    '',
    text,
    '',
    '# Plugins',
    '',
    plugins,
  ].join('\n');
  return { prompt, dropped };
}

const MAX_ITEMS = 6;

/**
 * Keep only what the answer may contain: known plugins, versions in that plugin's range, non-empty text. Duplicates are
 * merged and each plugin's items are capped. Plugins are returned in the work list's order.
 */
export function filterSuggestions(raw: unknown, work: ReturnType<typeof workList>['work']): PluginSuggestion[] {
  const list = raw && typeof raw === 'object' ? (raw as { suggestions?: unknown }).suggestions : undefined;
  if (!Array.isArray(list)) return [];
  const byId = new Map<string, SuggestionItem[]>();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = (s as { plugin?: unknown }).plugin;
    const w = typeof id === 'string' ? work.find((x) => x.cand.id === id) : undefined;
    if (!w) continue;
    const versions = new Set(w.entries.map((e) => e.version));
    const items = byId.get(w.cand.id) ?? [];
    for (const it of Array.isArray((s as { items?: unknown }).items) ? ((s as { items: unknown[] }).items) : []) {
      if (!it || typeof it !== 'object') continue;
      const { version, change, idea } = it as Record<string, unknown>;
      if (typeof version !== 'string' || !versions.has(version.replace(/^v/, ''))) continue;
      if (typeof change !== 'string' || typeof idea !== 'string' || !change.trim() || !idea.trim()) continue;
      if (items.some((x) => x.change === change.trim())) continue;
      items.push({ version: version.replace(/^v/, ''), change: change.trim().slice(0, 1000), idea: idea.trim().slice(0, 1000) });
    }
    if (items.length) byId.set(w.cand.id, items);
  }
  return work
    .filter((w) => byId.has(w.cand.id))
    .map((w) => ({ plugin: w.cand.id, title: w.cand.title, kind: w.cand.kind, since: w.since, items: byId.get(w.cand.id)!.slice(0, MAX_ITEMS) }));
}

/** The record to keep after an action: never moves a plugin's version backwards. */
export function nextRecord(prev: PluginRecord | undefined, next: PluginRecord): PluginRecord {
  if (prev && newer(prev.version, next.version)) return prev;
  return next;
}
