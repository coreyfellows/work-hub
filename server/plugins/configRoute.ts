/**
 * `GET/POST /api/plugins/config`: Settings → Plugins reads and writes plugins.json (`local` folders and `enabled`
 * switches; `settings` is kept as it is). Changes apply on the next start (and, for web code, the next build). The POST
 * is a write like any other: it sits behind the app's guard (signed in, JSON, same origin).
 */
import { isAbsolute, normalize } from 'node:path';
import type { Hono } from 'hono';
import { readPluginsConfig, writePluginsConfig, type PluginsConfig } from './config.ts';
import { discoverPlugins } from './discover.ts';

export type MergeResult = { ok: true; config: PluginsConfig } | { ok: false; error: string };

/**
 * Validate `body` (`{ local?: string[]; enabled?: Record<string, boolean> }`) and merge it over `current`: `local`
 * replaces the list (absolute paths, trimmed, duplicates dropped), `enabled` entries are set one by one. Only an entry
 * that changes the stored value must name a plugin id or alias found with the new local list (`knownIds(local)`); one
 * equal to what's stored is accepted as is, so a switch left behind by a plugin that's gone (folder removed, id
 * renamed) can never block a save. Stored entries the body doesn't mention are kept.
 */
export function mergePluginsConfig(current: PluginsConfig, body: unknown, knownIds: (local: string[]) => Set<string>): MergeResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'expected a JSON object' };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'local' && k !== 'enabled') return { ok: false, error: `unknown field: ${k}` };

  let local = current.local;
  if (b.local !== undefined) {
    if (!Array.isArray(b.local) || b.local.some((p) => typeof p !== 'string')) return { ok: false, error: 'local: expected an array of paths' };
    const out: string[] = [];
    for (const raw of b.local as string[]) {
      const p = raw.trim();
      if (!p) continue;
      if (!isAbsolute(p)) return { ok: false, error: `local: not an absolute path: ${p}` };
      const n = normalize(p);
      if (!out.includes(n)) out.push(n);
    }
    local = out;
  }

  const enabled = { ...current.enabled };
  if (b.enabled !== undefined) {
    if (!b.enabled || typeof b.enabled !== 'object' || Array.isArray(b.enabled)) return { ok: false, error: 'enabled: expected an object of id → boolean' };
    let known: Set<string> | null = null;
    for (const [id, on] of Object.entries(b.enabled as Record<string, unknown>)) {
      if (typeof on !== 'boolean') return { ok: false, error: `enabled.${id}: expected a boolean` };
      if (current.enabled[id] === on) continue; // unchanged: no need to know it
      known ??= knownIds(local);
      if (!known.has(id)) return { ok: false, error: `enabled: unknown plugin: ${id}` };
      enabled[id] = on;
    }
  }

  const config: PluginsConfig = { local, enabled };
  if (current.settings) config.settings = current.settings;
  return { ok: true, config };
}

/** Every plugin id and alias found in the official folder and `local`. */
export function knownPluginIds(officialDir: string, local: string[]): Set<string> {
  const ids = new Set<string>();
  for (const p of discoverPlugins(officialDir, local)) {
    ids.add(p.manifest.id);
    for (const a of p.manifest.aliases ?? []) ids.add(a);
  }
  return ids;
}

export function registerPluginsConfigRoutes(app: Hono, deps: { pluginsFile: string; officialDir: string }): void {
  // `warnings`: entries readPluginsConfig dropped (wrong types). Writing that config back would delete them for good.
  const read = (): (PluginsConfig & { warnings: string[] }) | { error: string } => {
    const warnings: string[] = [];
    try {
      return { ...readPluginsConfig(deps.pluginsFile, (m) => void warnings.push(m)), warnings };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  app.get('/api/plugins/config', (c) => {
    const cfg = read();
    if ('error' in cfg) return c.json(cfg, 500);
    return c.json({ local: cfg.local, enabled: cfg.enabled });
  });
  app.post('/api/plugins/config', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json({ error: 'expected a JSON body' }, 400);
    // A broken file is left for you to fix (overwriting it would lose its settings); Status shows the same error.
    const current = read();
    if ('error' in current) return c.json(current, 500);
    const { warnings, ...cfg } = current;
    if (warnings.length) return c.json({ error: 'plugins.json has invalid entries; fix the file first', warnings }, 409);
    const r = mergePluginsConfig(cfg, body, (local) => knownPluginIds(deps.officialDir, local));
    if (!r.ok) return c.json({ error: r.error }, 400);
    writePluginsConfig(deps.pluginsFile, r.config);
    return c.json({ local: r.config.local, enabled: r.config.enabled });
  });
}
