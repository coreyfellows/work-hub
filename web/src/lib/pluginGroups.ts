export interface GroupablePlugin {
  official: boolean;
  dir: string;
}

export interface PluginGroup<T> {
  /** `official`, or the local path the plugins came from. */
  key: string;
  title: string;
  /** Where it comes from, shown under the title (a local folder's path). */
  detail?: string;
  plugins: T[];
}

const trimSlash = (p: string) => p.replace(/[\\/]+$/, '');
const isInside = (dir: string, root: string) => {
  const d = trimSlash(dir).replace(/\\/g, '/');
  const r = trimSlash(root).replace(/\\/g, '/');
  return d === r || d.startsWith(`${r}/`);
};

/**
 * Splits the plugins by where they come from: the official ones bundled in the repo, then one group per local path
 * listed in plugins.json (the longest matching path wins when they nest), then "Other local" for any left over.
 * Groups with no plugins are left out, except a listed local path (so a typo shows up as an empty group).
 */
export function groupPlugins<T extends GroupablePlugin>(plugins: T[], local: string[]): Array<PluginGroup<T>> {
  const out: Array<PluginGroup<T>> = [];
  const official = plugins.filter((p) => p.official);
  if (official.length) out.push({ key: 'official', title: 'Official', detail: 'Bundled with work-hub', plugins: official });

  const paths = local.map((l) => l.trim()).filter(Boolean);
  const byPath = new Map<string, T[]>(paths.map((p) => [p, []]));
  const other: T[] = [];
  for (const p of plugins.filter((x) => !x.official)) {
    const home = paths.filter((root) => isInside(p.dir, root)).sort((a, b) => b.length - a.length)[0];
    if (home) byPath.get(home)!.push(p);
    else other.push(p);
  }
  for (const [path, list] of byPath) out.push({ key: `local:${path}`, title: 'Local', detail: path, plugins: list });
  if (other.length) out.push({ key: 'local-other', title: 'Other local', plugins: other });
  return out;
}
