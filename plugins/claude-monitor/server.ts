import { readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { readJson, type ServerPluginContext, type Workspace } from '../../plugin-api/server.ts';
import { candidates } from './candidates.ts';
import { between } from './changelog.ts';
import { changelogLoader, claudeConfigDir } from './changelogSource.ts';
import { monitorStore, MIGRATIONS } from './store.ts';
import { analysisPrompt, baselineOf, filterSuggestions, workList, type Analysis, type PluginSuggestion } from './suggest.ts';
import { ANALYZE_JOB, API, APPLY_JOB, SOURCE_ID, UPDATE_JOB, type MonitorData, type PluginRow, type WhatsNew } from './types.ts';
import { updatePrompt, updateSlug } from './updatePrompt.ts';
import { maxVersion, newer, parseVersion, pickChannel, versionFromCli, versionFromDistTags, type Channel } from './version.ts';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';
const DEFAULT_CHANGELOG = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
/** The source re-reads `claude --version` this often (cheap, catches Claude's own auto-updates); npm only every `checkHours`. */
const SOURCE_INTERVAL_MS = 30 * 60_000;

interface Check {
  at: number;
  version: string | null;
  channel: Channel;
  error: string | null;
}

export default function register(ctx: ServerPluginContext): void {
  ctx.db.migrate(MIGRATIONS);
  const store = monitorStore(() => ctx.db.raw());
  const loader = changelogLoader({ cacheDir: ctx.paths.pluginCache, url: () => ctx.config.get('changelogUrl', DEFAULT_CHANGELOG) || DEFAULT_CHANGELOG });
  const repoRoot = ctx.paths.repoRoot;
  const git = (args: string[], timeoutMs = 20_000) => ctx.exec.run('git', ['-C', repoRoot, ...args], { timeoutMs }).then((s) => s.trim());

  let forceCheck = false;
  let updating = false;
  let analyzing = false;
  let analysisError: string | null = null;
  let installedCache: string | null = null;

  const installedVersion = async (): Promise<string | null> => {
    try {
      installedCache = versionFromCli(await ctx.exec.run('claude', ['--version'], { timeoutMs: 15_000 }));
    } catch (e) {
      ctx.log.warn('claude --version failed:', (e as Error).message);
      installedCache = null;
    }
    return installedCache;
  };

  const channel = (): Channel => {
    let settings: unknown = null;
    try {
      settings = JSON.parse(readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8'));
    } catch {
      /* no settings: Claude's default channel */
    }
    return pickChannel(String(ctx.config.get('channel', 'auto')), settings);
  };

  /** npm's dist-tags, at most every `checkHours` (or when asked with ↻ / Check now). */
  const checkLatest = async (ch: Channel): Promise<Check> => {
    const last = store.get<Check>('check');
    const hours = Number(ctx.config.get('checkHours', 6)) || 6;
    if (!forceCheck && last && last.channel === ch && Date.now() - last.at < hours * 3600_000) return last;
    forceCheck = false;
    const url = String(ctx.config.get('registryUrl', DEFAULT_REGISTRY) || DEFAULT_REGISTRY);
    let next: Check;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = versionFromDistTags(await r.json(), ch);
      if (!v) throw new Error(`no "${ch}" version in the dist-tags`);
      next = { at: Date.now(), version: v, channel: ch, error: null };
    } catch (e) {
      next = { at: Date.now(), version: last?.channel === ch ? last.version : null, channel: ch, error: `npm: ${(e as Error).message}` };
    }
    store.set('check', next);
    return next;
  };

  /** Plugins with no `claudeVersion` and no record are noted as seen at the installed version: only later changes count. */
  const seedRecords = (installed: string) => {
    const records = store.records();
    for (const c of candidates(ctx.plugins.list(), { readmes: false })) {
      if (!c.manifestVersion && !records.has(c.id)) store.record({ pluginId: c.id, version: installed, action: 'seen', workspaceId: null });
    }
  };

  const snapshot = async (): Promise<MonitorData> => {
    const installed = await installedVersion();
    const ch = channel();
    const check = await checkLatest(ch);
    let acknowledged = store.get<string>('acknowledged');
    if (installed) {
      // First run: nothing to show yet; What's new starts with the next version.
      if (!acknowledged) store.set('acknowledged', (acknowledged = installed));
      seedRecords(installed);
    }
    const analysis = store.get<Analysis>('analysis');
    return {
      installed,
      latest: check.version,
      channel: ch,
      updateAvailable: !!installed && newer(check.version, installed),
      acknowledged,
      whatsNew: !!installed && newer(installed, acknowledged),
      checkedAt: check.at,
      checkError: check.error,
      updating,
      analysis: {
        status: analyzing ? 'running' : analysisError ? 'failed' : analysis ? 'done' : 'none',
        version: analysis?.version ?? null,
        count: analysis?.suggestions.length ?? 0,
        error: analysisError,
      },
    };
  };
  const refresh = () => void ctx.registry.refresh(SOURCE_ID).catch(() => {});

  const pluginRows = (): PluginRow[] => {
    const records = store.records();
    return candidates(ctx.plugins.list(), { readmes: false }).map((c) => {
      const r = records.get(c.id);
      return {
        id: c.id,
        title: c.title,
        kind: c.kind,
        manifestVersion: c.manifestVersion,
        record: r ? { version: r.version, action: r.action, workspaceId: r.workspaceId, at: r.at } : null,
        baseline: baselineOf(c.manifestVersion, r).version,
      };
    });
  };

  ctx.revalidate([`${API}/whats-new`, `${API}/suggestions`, `${API}/plugins`]);

  // What's new: from the acknowledged version (or the installed one, to preview an update) up to the newest known.
  ctx.app.get(`${API}/whats-new`, async (c) => {
    const installed = installedCache ?? (await installedVersion());
    const check = store.get<Check>('check');
    const latest = check?.version ?? null;
    const ack = store.get<string>('acknowledged');
    const q = (k: string) => {
      const v = c.req.query(k);
      return v && parseVersion(v) ? v : null;
    };
    const to = q('to') ?? maxVersion(installed, latest);
    let from = q('from') ?? (installed && newer(installed, ack) ? ack : installed);
    const { entries, from: src, error } = await loader.load(to);
    let picked = to ? between(entries, from, to) : [];
    if (!picked.length && to) {
      // Nothing between them (up to date, nothing unseen): show the current version's own notes.
      picked = between(entries, null, to).slice(0, 1);
      from = null;
    }
    const body: WhatsNew = { from, to, installed, latest, entries: picked, changelog: src, error };
    return c.json(body);
  });

  ctx.app.get(`${API}/suggestions`, (c) => c.json({ analysis: store.get<Analysis>('analysis') }));
  ctx.app.get(`${API}/plugins`, (c) => c.json({ plugins: pluginRows() }));

  ctx.app.post(`${API}/check`, async (c) => {
    forceCheck = true;
    await ctx.registry.refresh(SOURCE_ID).catch(() => {});
    return c.json({ ok: true });
  });

  ctx.app.post(`${API}/seen`, async (c) => {
    const b = await readJson(c);
    const v = typeof b.version === 'string' && parseVersion(b.version) ? b.version : null;
    if (!v) return c.json({ error: 'version: expected x.y.z' }, 400);
    store.set('acknowledged', maxVersion(store.get<string>('acknowledged'), v));
    refresh();
    return c.json({ ok: true });
  });

  ctx.app.post(`${API}/update`, (c) => {
    if (updating) return c.json({ error: 'Claude Code is already updating' }, 409);
    updating = true;
    refresh();
    const job = ctx.jobs.start({ kind: UPDATE_JOB, title: 'Update Claude Code' }, async (progress) => {
      try {
        const before = installedCache ?? (await installedVersion());
        progress(`claude update (from ${before ?? 'unknown'})`);
        const out = await ctx.exec.run('claude', ['update'], { timeoutMs: 10 * 60_000 });
        const after = await installedVersion();
        const tail = out.trim().split('\n').filter(Boolean).pop() ?? '';
        if (after && before && newer(after, before)) return { detail: `Claude Code ${before} → ${after}. Running sessions keep their version until restarted.` };
        return { detail: tail || `Claude Code is at ${after ?? 'an unknown version'}` };
      } finally {
        updating = false;
        forceCheck = true;
        refresh();
      }
    });
    return c.json({ jobId: job.id }, 202);
  });

  ctx.app.post(`${API}/analyze`, async (c) => {
    if (analyzing) return c.json({ error: 'Already looking at the plugins' }, 409);
    const installed = installedCache ?? (await installedVersion());
    if (!installed) return c.json({ error: "Can't tell which Claude Code version is installed (claude --version failed)" }, 400);
    analyzing = true;
    analysisError = null;
    refresh();
    const model = String(ctx.config.get('analysisModel', 'sonnet') || 'sonnet');
    const job = ctx.jobs.start({ kind: ANALYZE_JOB, title: `Plugin ideas from Claude Code ${installed}` }, async (progress) => {
      try {
        seedRecords(installed);
        const { entries, error } = await loader.load(installed);
        if (!entries.length) throw new Error(error ?? 'no changelog');
        const { work, upToDate } = workList(candidates(ctx.plugins.list()), store.records(), entries, installed);
        let suggestions: PluginSuggestion[] = [];
        let costUsd: number | null = null;
        let dropped = 0;
        if (work.length) {
          progress(`Asking ${model} about ${work.length} plugin${work.length === 1 ? '' : 's'}`);
          const p = analysisPrompt(work);
          dropped = p.dropped;
          const r = await ctx.headless.askClaudeJson<unknown>('claude-monitor', p.prompt, { model, maxTurns: 2, timeoutMs: 10 * 60_000 });
          costUsd = r.costUsd;
          suggestions = filterSuggestions(r.value, work);
        }
        const analysis: Analysis = { version: installed, at: new Date().toISOString(), suggestions, upToDate, costUsd, dropped };
        store.set('analysis', analysis);
        const n = suggestions.length;
        return { detail: work.length ? `${n} plugin${n === 1 ? '' : 's'} could use something new${costUsd != null ? ` ($${costUsd.toFixed(2)})` : ''}` : 'Every plugin is up to date with this version' };
      } catch (e) {
        analysisError = (e as Error).message;
        throw e;
      } finally {
        analyzing = false;
        refresh();
      }
    });
    return c.json({ jobId: job.id }, 202);
  });

  /** The worktree's base: the checkout's upstream when the checkout has nothing it lacks, else its branch (plugin-author's rule). */
  const baseRef = async (): Promise<string> => {
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '');
    if (upstream && (await git(['merge-base', '--is-ancestor', 'HEAD', upstream]).then(() => true, () => false))) return upstream;
    return (await git(['branch', '--show-current']).catch(() => '')) || 'HEAD';
  };

  /** One plugin's update: a work-hub worktree, a workspace and a session. Anything made is taken back if a step fails. */
  const startUpdate = async (version: string, s: PluginSuggestion, dir: string): Promise<{ workspaceId: string; sessionId: string }> => {
    const undo: Array<(err: unknown) => Promise<void> | void> = [];
    try {
      const slug = updateSlug(version, s.plugin);
      const repoName = (await ctx.git.branchInfo(repoRoot).catch(() => null))?.repo?.split('/').pop() || basename(repoRoot);
      const worktree = join(ctx.paths.worktreesDir, repoName, slug);
      const base = await baseRef();
      await git(['worktree', 'add', worktree, '-b', slug, base], 60_000);
      undo.push(async () => {
        await git(['worktree', 'remove', '--force', worktree]).catch((e) => ctx.log.warn('undo: worktree remove', e));
        await git(['branch', '-D', slug]).catch((e) => ctx.log.warn('undo: branch delete', e));
      });
      await ctx.sessions.trustWorktree(worktree);

      let realRepo = repoRoot;
      try {
        realRepo = realpathSync(repoRoot);
      } catch {
        /* keep as is */
      }
      const rel = relative(realRepo, realpathSync(dir));
      const official = s.kind === 'official' && !rel.startsWith('..');
      const pluginDir = official ? join(worktree, rel) : dir;

      const title = `Claude ${version}: ${s.title}`;
      const id = ctx.store.createWorkspace({ title, origin: 'prompt', prompt: s.items.map((i) => `${i.version}: ${i.idea}`).join('\n'), status: 'active' });
      undo.push((err) => {
        ctx.store.removeWorktreeRecord(id, worktree);
        ctx.store.logEvent(id, 'create-failed', err instanceof Error ? err.message : String(err));
        ctx.store.setStatus(id, 'done');
      });
      ctx.store.addWorktree(id, { repo: repoName, path: worktree, branch: slug, baseBranch: base });
      const ws = ctx.store.getWorkspace(id) as Workspace;
      const model = String(ctx.config.get('updateModel', 'opus') || 'opus');
      const prompt = updatePrompt({
        workspaceId: id,
        version,
        suggestion: s,
        pluginDir,
        worktree,
        branch: slug,
        base,
        appRepo: repoRoot,
        whCommand: ctx.paths.whCommand,
        rules: ctx.prompts.workspaceRules(id),
      });
      const { shortId, sessionId } = await ctx.sessions.startBackground({
        cwd: worktree,
        name: ws.title,
        model,
        prompt,
        purpose: 'claude-monitor',
        addDirs: official ? [] : [dir],
      });
      ctx.store.addSession(id, { claudeSessionId: sessionId, role: 'main', name: ws.title, cwd: worktree });
      ctx.store.logEvent(id, 'dispatched', `plugin update ${shortId} (${model})`);
      return { workspaceId: id, sessionId };
    } catch (err) {
      for (const fn of undo.reverse()) {
        try {
          await fn(err);
        } catch (e) {
          ctx.log.warn('undo failed:', e);
        }
      }
      throw err;
    }
  };

  /** Plugins the user has dealt with leave the stored suggestions, so reopening the modal doesn't offer them again. */
  const dropFromAnalysis = (version: string, ids: string[]) => {
    const a = store.get<Analysis>('analysis');
    if (!a || a.version !== version || !ids.length) return;
    store.set('analysis', { ...a, suggestions: a.suggestions.filter((s) => !ids.includes(s.plugin)) });
  };

  // The user's pick: update some plugins (one workspace each), skip the others for this version.
  ctx.app.post(`${API}/apply`, async (c) => {
    const b = await readJson(c);
    const analysis = store.get<Analysis>('analysis');
    if (!analysis || b.version !== analysis.version) return c.json({ error: 'These suggestions are out of date: look again' }, 409);
    const ids = (k: string) => (Array.isArray(b[k]) ? (b[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const known = new Map(analysis.suggestions.map((s) => [s.plugin, s]));
    const update = [...new Set(ids('update'))];
    const skip = [...new Set(ids('skip'))].filter((id) => !update.includes(id));
    const unknown = [...update, ...skip].filter((id) => !known.has(id));
    if (unknown.length) return c.json({ error: `Not in the suggestions: ${unknown.join(', ')}` }, 400);
    if (!update.length && !skip.length) return c.json({ error: 'Pick plugins to update or skip' }, 400);

    for (const id of skip) store.record({ pluginId: id, version: analysis.version, action: 'skipped', workspaceId: null });
    dropFromAnalysis(analysis.version, skip);
    if (!update.length) return c.json({ ok: true, skipped: skip.length });

    const dirs = new Map(ctx.plugins.list().map((p) => [p.id, p.dir]));
    const missing = update.filter((id) => !dirs.has(id));
    if (missing.length) return c.json({ error: `Plugin not found: ${missing.join(', ')}` }, 400);
    const job = ctx.jobs.start({ kind: APPLY_JOB, title: `Update ${update.length} plugin${update.length === 1 ? '' : 's'} for Claude Code ${analysis.version}` }, async (progress) => {
      const done: string[] = [];
      const failed: string[] = [];
      let first: { workspaceId: string } | null = null;
      for (const id of update) {
        const s = known.get(id)!;
        progress(`Starting ${s.title} (${done.length + failed.length + 1}/${update.length})`);
        try {
          const r = await startUpdate(analysis.version, s, dirs.get(id)!);
          store.record({ pluginId: id, version: analysis.version, action: 'updating', workspaceId: r.workspaceId });
          dropFromAnalysis(analysis.version, [id]);
          first ??= r;
          done.push(s.title);
        } catch (e) {
          ctx.log.warn(`update of ${id} failed to start:`, e);
          failed.push(`${s.title}: ${(e as Error).message}`);
        }
      }
      void ctx.registry.refresh('workspaces').catch(() => {});
      void ctx.registry.refresh('claude').catch(() => {});
      if (!done.length) throw new Error(failed.join('; '));
      return {
        detail: `Started ${done.join(', ')}${failed.length ? `; failed: ${failed.join('; ')}` : ''}`,
        link: first ? { to: `/workspaces/${first.workspaceId}`, label: done.length > 1 ? 'Open the first workspace' : 'Open workspace' } : null,
      };
    });
    return c.json({ jobId: job.id, skipped: skip.length }, 202);
  });

  // Last: a source can't be taken back if register() throws.
  ctx.registry.add({ id: SOURCE_ID, title: 'Claude Code version', intervalMs: SOURCE_INTERVAL_MS, fetch: snapshot });
}
