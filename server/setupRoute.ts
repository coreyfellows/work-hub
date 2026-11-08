/**
 * First-run setup. `GET /api/setup` says whether the first-run page is still open and what it asks: the repos and
 * worktrees folders, plus every active plugin setting marked `firstRun` that has no value yet (settings sharing an env var,
 * like the two Jira URLs, are asked once). `POST /api/setup` ({ reposDir?, worktreesDir?, values? }) checks and stores the
 * answers and closes the page for good; `POST /api/setup/skip` closes it with the defaults. `GET /api/setup/checks` runs
 * the tool checks (lib/prereqs.ts) on demand. Everything asked stays editable in Settings.
 */
import type { Hono } from 'hono';
import { run } from './lib/exec.ts';
import { checkFolder, folderState, REPOS_KEY, SETUP_DONE_KEY, WORKTREES_KEY } from './lib/folders.ts';
import { runPrereqs } from './lib/prereqs.ts';
import { applySettings, resolveFull, settingsGroups, settingKey } from './settings.ts';
import { appSetting, setAppSetting } from './store/appSettings.ts';
import type { ResolvedPlugin } from './plugins/resolve.ts';

/** Set (to true) once the whole first-run page has been answered or skipped. */
export const WIZARD_DONE_KEY = 'setup.done';

export interface SetupQuestion {
  /** The settings it fills (more than one when plugins share an env var). */
  keys: string[];
  label: string;
  description?: string;
  placeholder?: string;
  /** Which plugin(s) asked, for the label next to it. */
  from: string[];
  /** Saving it needs a restart to take effect. */
  restart: boolean;
}

/** A plugin that is off, offered on the first-run page (manifest `firstRunOffer`). */
export interface SetupOffer {
  id: string;
  label: string;
  description?: string;
  /** One question asked when it's ticked; `key` is the full setting key (`<plugin id>.<key>`). */
  ask?: { key: string; label: string; placeholder?: string };
}

/**
 * Plugins that are off by default and offer themselves on the first-run page; not ones the user turned off on purpose
 * (`turnedOff`: plugins.json `enabled[id] === false`). `ask` is kept only when it names one of the plugin's string
 * settings, so the answer is stored like that setting.
 */
export function pendingOffers(plugins: ResolvedPlugin[], turnedOff: Set<string> = new Set()): SetupOffer[] {
  return plugins
    .filter((p) => p.status === 'disabled' && p.manifest.firstRunOffer && !turnedOff.has(p.manifest.id))
    .map((p) => {
      const o = p.manifest.firstRunOffer!;
      const askDef = o.ask && p.manifest.settings?.find((d) => d.key === o.ask!.key && (d.type === 'string' || d.type === 'text'));
      return {
        id: p.manifest.id,
        label: o.label,
        ...(o.description && { description: o.description }),
        ...(o.ask && askDef && { ask: { key: settingKey(p.manifest.id, o.ask.key), label: o.ask.label, ...(o.ask.placeholder && { placeholder: o.ask.placeholder }) } }),
      };
    });
}

/** What the first-run page needs from the plugin loader (index.ts). */
export interface SetupDeps {
  offers: () => SetupOffer[];
  /** Turns these plugins on in plugins.json (applies after a rebuild and restart). */
  enable: (ids: string[]) => void;
}

export interface SetupStatus {
  needed: boolean;
  reposDir: string;
  worktreesDir: string;
  /** Folders an env var fixes (the page shows them as given). */
  locked: { reposDir: boolean; worktreesDir: boolean };
  reposExists: boolean;
  worktreesExists: boolean;
  /** Whether the folders still need answering (false once answered, or both set by env/Settings). */
  foldersOpen: boolean;
  questions: SetupQuestion[];
  offers: SetupOffer[];
}

/** The `firstRun` settings of active plugins with no value yet, shared-env ones merged. */
export function pendingQuestions(): SetupQuestion[] {
  const out = new Map<string, SetupQuestion>();
  for (const g of settingsGroups()) {
    for (const d of g.defs) {
      if (!d.firstRun) continue;
      const key = settingKey(g.id, d.key);
      const r = resolveFull(key);
      if (!r || r.source !== 'default' || (typeof r.value === 'string' ? r.value.trim() : r.value) ) continue;
      const id = d.env ?? key;
      const q = out.get(id);
      if (q) {
        q.keys.push(key);
        q.from.push(g.title);
      } else {
        out.set(id, { keys: [key], label: d.label, description: d.description, placeholder: d.placeholder, from: [g.title], restart: !!d.restart });
      }
    }
  }
  return [...out.values()];
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? '');

export async function setupStatus(deps?: SetupDeps): Promise<SetupStatus> {
  const repos = resolveFull(REPOS_KEY)!;
  const trees = resolveFull(WORKTREES_KEY)!;
  const reposDir = String(repos.value);
  const worktreesDir = String(trees.value);
  const explicit = (r: { source: string }) => r.source !== 'default';
  const foldersOpen = appSetting(SETUP_DONE_KEY) !== true && !(explicit(repos) && explicit(trees));
  const questions = pendingQuestions();
  const offers = deps?.offers() ?? [];
  return {
    // Open until answered or skipped, if there is anything left to ask. Offers ride along but never open the page on
    // their own: an existing user (folders answered before setup.done existed) shouldn't meet the Welcome page again.
    needed: appSetting(WIZARD_DONE_KEY) !== true && (foldersOpen || questions.length > 0),
    reposDir,
    worktreesDir,
    locked: { reposDir: repos.source === 'env', worktreesDir: trees.source === 'env' },
    reposExists: (await folderState(expand(reposDir))) === 'dir',
    worktreesExists: (await folderState(expand(worktreesDir))) === 'dir',
    foldersOpen,
    questions,
    offers,
  };
}

export function registerSetupRoutes(app: Hono, deps?: SetupDeps): void {
  app.get('/api/setup', async (c) => c.json(await setupStatus(deps)));
  app.get('/api/setup/checks', async (c) => c.json({ checks: await runPrereqs(run) }));
  app.post('/api/setup/skip', (c) => {
    setAppSetting(WIZARD_DONE_KEY, true);
    return c.json({ ok: true });
  });
  app.post('/api/setup', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { reposDir?: unknown; worktreesDir?: unknown; values?: unknown; enable?: unknown; offerValues?: unknown } | null;
    const status = await setupStatus(deps);
    const errors: Record<string, string> = {};
    const folders: Record<string, string> = {};
    if (status.foldersOpen) {
      // A folder an env var fixes isn't asked: the env value stays in force whatever is posted.
      for (const [field, key, create, locked] of [
        ['reposDir', REPOS_KEY, false, status.locked.reposDir],
        ['worktreesDir', WORKTREES_KEY, true, status.locked.worktreesDir],
      ] as const) {
        if (locked) continue;
        const r = await checkFolder(body?.[field], { create });
        if (r.error) errors[field] = r.error;
        else folders[key] = r.path!;
      }
    }
    // Answers to the plugin questions: only keys that were asked, blanks skipped.
    const allowed = new Set(status.questions.flatMap((q) => q.keys));
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries((body?.values ?? {}) as Record<string, unknown>)) {
      if (!allowed.has(k)) {
        errors[k] = 'not a setting the first-run page asks';
      } else if (typeof v === 'string' && v.trim()) {
        values[k] = v.trim();
      }
    }
    // Plugins offered while off: only those, and only the question an enabled one asks.
    const enable: string[] = [];
    const offerValues: Record<string, string> = {};
    if (body?.enable !== undefined) {
      const offered = new Map(status.offers.map((o) => [o.id, o]));
      if (!Array.isArray(body.enable)) errors.enable = 'enable: expected a list of plugin ids';
      else
        for (const id of body.enable) {
          if (typeof id !== 'string' || !offered.has(id)) errors.enable = `enable: not offered: ${String(id)}`;
          else enable.push(id);
        }
      const asked = new Set(enable.map((id) => offered.get(id)?.ask?.key).filter(Boolean));
      for (const [k, v] of Object.entries((body.offerValues ?? {}) as Record<string, unknown>)) {
        if (!asked.has(k)) errors[k] = 'not a question the first-run page asks';
        else if (typeof v === 'string' && v.trim()) offerValues[k] = v.trim().slice(0, 1000);
      }
    }
    if (!Object.keys(errors).length) {
      const bad = applySettings(values, () => {}); // validate only; stored below
      if (bad) errors.values = bad;
    }
    if (Object.keys(errors).length) return c.json({ error: Object.values(errors).join('; '), errors }, 400);
    // Turning plugins on first: if plugins.json can't be written, nothing else is stored and a retry starts clean.
    if (enable.length) {
      try {
        deps?.enable(enable);
      } catch (err) {
        return c.json({ error: `couldn't turn on ${enable.join(', ')}: ${(err as Error).message}` }, 500);
      }
    }
    for (const [k, v] of Object.entries(folders)) setAppSetting(k, v);
    if (status.foldersOpen) setAppSetting(SETUP_DONE_KEY, true);
    applySettings(values, (k, v) => setAppSetting(k, v));
    // The plugin is off, so its settings group isn't registered: store the answer under its key directly.
    for (const [k, v] of Object.entries(offerValues)) setAppSetting(k, v);
    setAppSetting(WIZARD_DONE_KEY, true);
    return c.json({
      ...(await setupStatus(deps)),
      restart: enable.length > 0 || status.questions.some((q) => q.restart && q.keys.some((k) => k in values)),
      ...(enable.length && { rebuild: true }),
    });
  });
}
