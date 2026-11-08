/** Reading the plugins the analysis looks at: manifest `claudeVersion`, description and README excerpts. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginListEntry } from '../../plugin-api/server.ts';
import type { Candidate } from './suggest.ts';
import { parseVersion } from './version.ts';

const README_CHARS = 3000;
const SUB_README_CHARS = 600;

const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/** plugin.json, or {} when unreadable. */
export function readManifest(dir: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** The plugin's README, cut, plus the start of each feature README in its direct subfolders (conversation-view's). */
export function readmeExcerpt(dir: string): string {
  const parts = [readText(join(dir, 'README.md')).slice(0, README_CHARS)];
  let subs: string[] = [];
  try {
    subs = readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'node_modules').sort();
  } catch {
    /* unreadable folder: just the README */
  }
  for (const n of subs) {
    const p = join(dir, n, 'README.md');
    try {
      if (!statSync(join(dir, n)).isDirectory() || !existsSync(p)) continue;
    } catch {
      continue;
    }
    parts.push(`#### Feature \`${n}\`\n${readText(p).slice(0, SUB_README_CHARS)}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Active official and local plugins (built-ins are the app's own and aren't offered), with what the prompt needs. */
export function candidates(list: PluginListEntry[], opts: { readmes?: boolean } = {}): Candidate[] {
  return list
    .filter((p) => p.status === 'active' && (p.kind === 'official' || p.kind === 'local'))
    .map((p) => {
      const m = readManifest(p.dir);
      const cv = typeof m.claudeVersion === 'string' && parseVersion(m.claudeVersion) ? m.claudeVersion : null;
      return {
        id: p.id,
        title: p.title,
        kind: p.kind as 'official' | 'local',
        dir: p.dir,
        description: typeof m.description === 'string' ? m.description : '',
        readme: opts.readmes === false ? '' : readmeExcerpt(p.dir),
        manifestVersion: cv,
      };
    });
}
