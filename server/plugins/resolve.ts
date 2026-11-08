import { API_VERSION } from '../../plugin-api/manifest.ts';
import type { DiscoveredPlugin } from './discover.ts';
import type { PluginsConfig } from './config.ts';

export type PluginStatus = 'active' | 'disabled' | 'replaced' | 'skipped';
export interface ResolvedPlugin extends DiscoveredPlugin {
  /** Part of the app (builtin/): always on, not listed in Settings → Plugins, no switch. */
  builtin?: boolean;
  status: PluginStatus;
  reason?: string;
  replacedBy?: string;
}
export interface Resolution {
  plugins: ResolvedPlugin[];
  errors: string[];
}

function isEnabled(p: DiscoveredPlugin, cfg: PluginsConfig): boolean {
  const m = p.manifest;
  // Own keys only ("constructor" and friends aren't settings), and only real booleans.
  const on = (key: string) => Object.hasOwn(cfg.enabled, key) && typeof cfg.enabled[key] === 'boolean';
  if (on(m.id)) return cfg.enabled[m.id];
  for (const a of m.aliases ?? []) if (on(a)) return cfg.enabled[a];
  return m.defaultEnabled;
}

export function resolvePlugins(found: DiscoveredPlugin[], cfg: PluginsConfig, apiVersion: number = API_VERSION): Resolution {
  const errors = new Set<string>();
  const plugins: ResolvedPlugin[] = [];
  const seen = new Set<string>();

  for (const f of found) {
    const m = f.manifest;
    const r: ResolvedPlugin = { ...f, status: 'active' };
    if (f.error) {
      r.status = 'skipped';
      r.reason = f.error;
    } else if (seen.has(m.id)) {
      r.status = 'skipped';
      r.reason = 'duplicate id';
    } else if (m.apiVersion !== apiVersion) {
      r.status = 'skipped';
      // Name the exact CHANGELOG.md heading: older plugins migrate, newer ones need a newer work-hub.
      r.reason = m.apiVersion < apiVersion
        ? `needs plugin API v${apiVersion} (declares v${m.apiVersion}): see CHANGELOG.md, "Plugin API ${apiVersion}" → "Migration steps"`
        : `needs plugin API v${apiVersion} (declares v${m.apiVersion}): it is newer than this work-hub, so update work-hub (CHANGELOG.md, "Versioning policy")`;
    } else if (!isEnabled(f, cfg)) {
      r.status = 'disabled';
    }
    if (!f.error && !seen.has(m.id)) seen.add(m.id);
    plugins.push(r);
  }

  const active = () => plugins.filter((p) => p.status === 'active');
  for (let changed = true; changed; ) {
    changed = false;

    // requires: every required id must be active
    const ids = new Set(active().map((p) => p.manifest.id));
    for (const p of active()) {
      const missing = (p.manifest.requires ?? []).find((id) => !ids.has(id));
      if (missing) {
        p.status = 'skipped';
        p.reason = `requires ${missing}, which is off`;
        changed = true;
        break;
      }
    }
    if (changed) continue;

    // replaces: group active replacers by target
    const byTarget = new Map<string, ResolvedPlugin[]>();
    for (const p of active()) {
      const t = p.manifest.replaces;
      if (t) byTarget.set(t, [...(byTarget.get(t) ?? []), p]);
    }
    for (const [target, replacers] of byTarget) {
      if (replacers.length > 1) {
        const names = replacers.map((r) => r.manifest.id).join(', ');
        errors.add(`${names} all replace ${target}; turn all but one off`);
        for (const r of replacers) {
          r.status = 'skipped';
          r.reason = `conflicts with another plugin that replaces ${target}`;
        }
        changed = true;
        break;
      }
    }
    if (changed) continue;

    for (const [target, [replacer]] of byTarget) {
      const t = plugins.find((p) => p.manifest.id === target && p.status === 'active');
      if (t) {
        t.status = 'replaced';
        t.replacedBy = replacer.manifest.id;
        changed = true;
      }
    }
  }

  for (const p of active()) {
    const t = p.manifest.replaces;
    if (t && !plugins.some((x) => x.manifest.id === t)) p.reason = `replaces ${t}, which is not installed`;
  }
  return { plugins, errors: [...errors] };
}
