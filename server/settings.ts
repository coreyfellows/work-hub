/**
 * The settings registry: groups of editable settings (the core's own and the ones plugins declare in their manifest),
 * and how a value is resolved. Resolution order, first hit wins: the env var, plugins.json `settings` (plugins only),
 * what Settings stored (`app_settings`), the default. Resolution and validation are pure so they can be tested; the
 * routes (settingsRoute.ts) and `ctx.config.get` do the I/O.
 */
import type { SettingDef, SettingValue } from '../plugin-api/manifest.ts';
import { appSetting } from './store/appSettings.ts';

export interface SettingGroup {
  /** Core groups: the key prefix. Plugin groups: the plugin id (also the prefix). */
  id: string;
  title: string;
  description?: string;
  /** Position among the Settings sections (the core's are 20 Workspaces, 30 Data, 60 Plugins). */
  order: number;
  /** One of the app's own features (builtin/): its section sits on the main Settings page, not a plugin's page. */
  builtin?: boolean;
  defs: SettingDef[];
}

export type SettingSource = 'default' | 'app' | 'env' | 'plugins.json';

export interface ResolvedSetting {
  value: SettingValue | undefined;
  source: SettingSource;
  /** The env var that is overriding it, when source is 'env'. */
  envName?: string;
}

const groups = new Map<string, SettingGroup>();
/** plugins.json `settings` (by plugin id), set by the loader. */
let pluginsJson: Record<string, Record<string, unknown>> = {};

export function registerSettingsGroup(g: SettingGroup): void {
  groups.set(g.id, g);
}
export function removeSettingsGroup(id: string): void {
  groups.delete(id);
}
export function settingsGroups(): SettingGroup[] {
  return [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}
export function setPluginsJsonSettings(s: Record<string, Record<string, unknown>> | undefined): void {
  pluginsJson = s ?? {};
}

export const settingKey = (groupId: string, key: string): string => `${groupId}.${key}`;

/** Env value → the def's type (a number or boolean that doesn't parse is ignored: undefined). */
export function coerceEnv(raw: string, def: SettingDef): SettingValue | undefined {
  if (def.type === 'number') {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }
  if (def.type === 'boolean') {
    const v = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
    return undefined;
  }
  return raw;
}

/** The env var name for a group's setting: the def's own, else (plugins) WORK_HUB_<ID>_<KEY>. */
export function envNameFor(g: SettingGroup, def: SettingDef, plugin: boolean, envName: (id: string, key: string) => string): string | undefined {
  return def.env ?? (plugin ? envName(g.id, def.key) : undefined);
}

export interface ResolveInputs {
  env?: Record<string, string | undefined>;
  /** plugins.json value, when this is a plugin's setting. */
  fileValue?: unknown;
  stored?: unknown;
  envName?: string;
}

/** Pure resolution of one setting from its inputs. */
export function resolveSetting(def: SettingDef, inputs: ResolveInputs): ResolvedSetting {
  const raw = inputs.envName ? inputs.env?.[inputs.envName] : undefined;
  if (raw !== undefined) {
    const v = coerceEnv(raw, def);
    if (v !== undefined) return { value: v, source: 'env', envName: inputs.envName };
  }
  if (inputs.fileValue !== undefined) return { value: inputs.fileValue as SettingValue, source: 'plugins.json' };
  if (inputs.stored !== undefined) return { value: inputs.stored as SettingValue, source: 'app' };
  return { value: def.default, source: 'default' };
}

export type Checked = { ok: true; value: SettingValue | null } | { ok: false; error: string };

/** Validate a value from the API against its def. `null` clears the setting (the default applies again). */
export function checkValue(def: SettingDef, v: unknown): Checked {
  if (v === null) return { ok: true, value: null };
  switch (def.type) {
    case 'boolean':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: `${def.key}: expected true or false` };
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${def.key}: expected a number` };
      if (def.min !== undefined && v < def.min) return { ok: false, error: `${def.key}: at least ${def.min}` };
      if (def.max !== undefined && v > def.max) return { ok: false, error: `${def.key}: at most ${def.max}` };
      return { ok: true, value: v };
    }
    case 'select':
      return typeof v === 'string' && (def.options ?? []).some((o) => o.value === v) ? { ok: true, value: v } : { ok: false, error: `${def.key}: not one of the options` };
    case 'string':
    case 'text': {
      if (typeof v !== 'string') return { ok: false, error: `${def.key}: expected text` };
      if (v.length > (def.type === 'text' ? 20_000 : 1_000)) return { ok: false, error: `${def.key}: too long` };
      return { ok: true, value: v };
    }
  }
}

function lookup(fullKey: string): { group: SettingGroup; def: SettingDef } | undefined {
  for (const g of groups.values()) for (const d of g.defs) if (settingKey(g.id, d.key) === fullKey) return { group: g, def: d };
  return undefined;
}

/** Plugins' groups (set by the loader) vs the core's: only plugins have plugins.json values and the default env name. */
const pluginGroups = new Set<string>();
export function markPluginGroup(id: string): void {
  pluginGroups.add(id);
}
export function unmarkPluginGroup(id: string): void {
  pluginGroups.delete(id);
}

let envNameFn: (id: string, key: string) => string = (id, key) => `WORK_HUB_${id}_${key}`.toUpperCase();
export function setEnvNamer(f: (id: string, key: string) => string): void {
  envNameFn = f;
}

/** Resolve one setting by its full key, from the live env, plugins.json and the database. */
export function resolveFull(fullKey: string): ResolvedSetting | undefined {
  const hit = lookup(fullKey);
  if (!hit) return undefined;
  const plugin = pluginGroups.has(hit.group.id);
  return resolveSetting(hit.def, {
    env: process.env,
    envName: envNameFor(hit.group, hit.def, plugin, envNameFn),
    fileValue: plugin ? pluginsJson[hit.group.id]?.[hit.def.key] : undefined,
    stored: appSetting(fullKey),
  });
}

/** The value in force for a core setting (`<group>.<key>`); the def's default when nothing is set. */
export function getSetting<T extends SettingValue>(fullKey: string): T {
  return resolveFull(fullKey)?.value as T;
}

export interface SettingField extends SettingDef {
  fullKey: string;
  value: SettingValue | undefined;
  source: SettingSource;
  envName?: string;
}
export interface SettingsPayload {
  groups: Array<{ id: string; title: string; description?: string; order: number; plugin: boolean; builtin: boolean; fields: SettingField[] }>;
}

/** What `GET /api/settings` returns. */
export function settingsPayload(): SettingsPayload {
  return {
    groups: settingsGroups().map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      order: g.order,
      plugin: pluginGroups.has(g.id),
      builtin: !!g.builtin,
      fields: g.defs.map((d) => {
        const fullKey = settingKey(g.id, d.key);
        const r = resolveFull(fullKey)!;
        return { ...d, fullKey, value: r.value, source: r.source, envName: r.envName };
      }),
    })),
  };
}

/** Apply `{ fullKey: value | null }`: validates all first, so a bad entry changes nothing. Returns an error message or null. */
export function applySettings(values: unknown, store: (key: string, value: SettingValue | null) => void): string | null {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return 'expected { values: { key: value } }';
  const todo: Array<[string, SettingValue | null]> = [];
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const hit = lookup(k);
    if (!hit) return `unknown setting: ${k}`;
    const c = checkValue(hit.def, v);
    if (!c.ok) return c.error;
    todo.push([k, c.value]);
  }
  for (const [k, v] of todo) store(k, v);
  return null;
}
