import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PluginsConfig {
  local: string[];
  enabled: Record<string, boolean>;
  settings?: Record<string, Record<string, unknown>>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Missing file gives defaults (and creates nothing); invalid JSON throws, naming the file. Values of the wrong type are
 * dropped with a warning (`warn`, default console.warn): `enabled` values must be booleans (the string "false" would
 * otherwise count as on), `local` entries strings, `settings` an object of objects.
 */
export function readPluginsConfig(file: string, warn: (message: string) => void = (m) => console.warn(m)): PluginsConfig {
  if (!existsSync(file)) return { local: [], enabled: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid plugins config ${file}: ${(e as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`Invalid plugins config ${file}: expected a JSON object`);
  const bad = (what: string) => warn(`plugins config ${file}: ${what}; ignored`);

  const local: string[] = [];
  if (raw.local !== undefined && !Array.isArray(raw.local)) bad('"local" must be a list of folders');
  for (const x of Array.isArray(raw.local) ? raw.local : []) {
    if (typeof x === 'string') local.push(x);
    else bad(`"local" entry ${JSON.stringify(x)} is not a string`);
  }

  const enabled: Record<string, boolean> = {};
  if (raw.enabled !== undefined && !isObject(raw.enabled)) bad('"enabled" must be an object of true/false');
  for (const [id, on] of Object.entries(isObject(raw.enabled) ? raw.enabled : {})) {
    if (typeof on === 'boolean') enabled[id] = on;
    else bad(`enabled.${id} must be true or false (got ${JSON.stringify(on)})`);
  }

  const cfg: PluginsConfig = { local, enabled };
  if (raw.settings !== undefined) {
    if (!isObject(raw.settings)) bad('"settings" must be an object keyed by plugin id');
    else {
      const settings: Record<string, Record<string, unknown>> = {};
      for (const [id, v] of Object.entries(raw.settings)) {
        if (isObject(v)) settings[id] = v;
        else bad(`settings.${id} must be an object`);
      }
      cfg.settings = settings;
    }
  }
  return cfg;
}

export function writePluginsConfig(file: string, cfg: PluginsConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
