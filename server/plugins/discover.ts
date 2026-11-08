import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PluginManifest } from '../../plugin-api/manifest.ts';

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  official: boolean;
  error?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function load(dir: string, official: boolean): DiscoveredPlugin {
  const fallback = basename(dir);
  const bad = (error: string): DiscoveredPlugin => ({
    manifest: { id: fallback, apiVersion: 0, title: fallback, defaultEnabled: false },
    dir,
    official,
    error,
  });
  let m: unknown;
  try {
    m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  } catch (e) {
    return bad(`plugin.json: ${(e as Error).message}`);
  }
  if (!m || typeof m !== 'object') return bad('plugin.json: not an object');
  const o = m as Partial<PluginManifest>;
  if (typeof o.id !== 'string' || !o.id) return bad('plugin.json: missing id');
  if (typeof o.apiVersion !== 'number') {
    const b = bad('plugin.json: missing apiVersion');
    return { ...b, manifest: { ...b.manifest, id: o.id, title: o.title ?? o.id } };
  }
  return {
    manifest: { ...o, id: o.id, apiVersion: o.apiVersion, title: o.title ?? o.id, defaultEnabled: o.defaultEnabled ?? false },
    dir,
    official,
  };
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).sort().map((n) => join(dir, n)).filter(isDir);
  } catch {
    return [];
  }
}

/** Official plugins first, then local ones. A local path is either a plugin (has plugin.json) or a folder of plugins. */
export function discoverPlugins(officialDir: string, localPaths: string[]): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  for (const d of childDirs(officialDir)) if (existsSync(join(d, 'plugin.json'))) out.push(load(d, true));
  for (const p of localPaths) {
    if (!isDir(p)) {
      out.push({ manifest: { id: basename(p), apiVersion: 0, title: basename(p), defaultEnabled: false }, dir: p, official: false, error: 'not a folder' });
    } else if (existsSync(join(p, 'plugin.json'))) {
      out.push(load(p, false));
    } else {
      for (const d of childDirs(p)) if (existsSync(join(d, 'plugin.json'))) out.push(load(d, false));
    }
  }
  return out;
}
