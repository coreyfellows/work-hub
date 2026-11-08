import { useSyncExternalStore } from 'react';

/**
 * "Settings: <plugin>" commands for the palette, one per active plugin with its own settings page (`/settings/plugins/<id>`):
 * the same rule as the Settings → Plugins rows' "Settings" link. `/api/plugins` and `/api/settings` are fetched once per
 * page load, the first time the palette lists commands (`loadPluginSettings()`), and `usePluginSettings()` re-renders when
 * they arrive.
 */
export interface PluginRow {
  manifest: { id: string; title: string };
  status: string;
}
export interface SettingsGroupRow {
  id: string;
  builtin?: boolean;
}

/** Active plugins that declare settings (not built in) or contribute a section of their own (`scope` other than 'app'). */
export function pluginsWithSettings(plugins: PluginRow[], groups: SettingsGroupRow[], sections: Array<{ plugin: string; scope?: string }>): Array<{ id: string; title: string }> {
  const has = (id: string) => groups.some((g) => g.id === id && !g.builtin) || sections.some((s) => s.plugin === id && s.scope !== 'app');
  return plugins.filter((p) => p.status === 'active' && has(p.manifest.id)).map((p) => ({ id: p.manifest.id, title: p.manifest.title }));
}

let state: { plugins: PluginRow[]; groups: SettingsGroupRow[] } | null = null;
let loading = false;
let failedAt = 0;
const subs = new Set<() => void>();

export function loadPluginSettings(fetchJson: <T>(url: string) => Promise<T>): void {
  if (state || loading || Date.now() - failedAt < 30_000) return;
  loading = true;
  Promise.all([fetchJson<{ plugins: PluginRow[] }>('/api/plugins'), fetchJson<{ groups: SettingsGroupRow[] }>('/api/settings')]).then(
    ([p, s]) => {
      state = { plugins: p.plugins, groups: s.groups };
      subs.forEach((f) => f());
    },
    // Not worth a toast: the palette just lacks these rows; listing commands again after 30s retries.
    () => {
      loading = false;
      failedAt = Date.now();
    },
  );
}

export function usePluginSettings(): typeof state {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}
