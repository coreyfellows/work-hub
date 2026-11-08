// The plugin import boundary checker (tests in boundary.test.ts): code under a plugin folder may import only npm
// packages, files inside that folder and plugin-api/. Pure apart from reading the files it checks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  why: string;
}

// `… from '<spec>'` (import and export-from, multi-line clauses included), side-effect `import '<spec>'`, and `import('<spec>')`.
export const SPECIFIER_RES = [/\bfrom\s*(['"])([^'"\n]+)\1/g, /\bimport\s*(['"])([^'"\n]+)\1/g, /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g];

export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/**
 * Boundary violations in one plugin folder: imports that reach into the core (`<root>/server`, `<root>/web/src`) or
 * leave the folder for anything but `<root>/plugin-api` (relative, absolute, or the `work-hub/plugin-api/...` alias).
 * npm packages and node: builtins are fine. `root` is the work-hub checkout; file names are reported relative to
 * `display` (default `root`). Used for official plugins (boundary.test.ts), local ones at load time (a warning) and
 * `scripts/check-plugin.ts`.
 */
export function checkPluginImports(pluginDir: string, root: string, display: string = root): Violation[] {
  const apiDir = join(root, 'plugin-api');
  const out: Violation[] = [];
  for (const file of sourceFiles(pluginDir)) {
    const text = readFileSync(file, 'utf8');
    const found = new Map<number, string>();
    for (const re of SPECIFIER_RES) for (const m of text.matchAll(re)) found.set(m.index, m[2]);
    const at = (index: number) => ({ file: relative(display, file), line: text.slice(0, index).split('\n').length });
    for (const [index, specifier] of [...found].sort((a, b) => a[0] - b[0])) {
      let target: string | null = null;
      if (specifier.startsWith('.') || isAbsolute(specifier)) target = resolve(dirname(file), specifier);
      else if (specifier === 'work-hub' || specifier.startsWith('work-hub/')) {
        const rest = specifier.slice('work-hub/'.length);
        target = resolve(root, rest);
        // The alias is for plugin-api only; anything else under work-hub/ is core.
        if (!rest.startsWith('plugin-api/') || !inside(target, apiDir)) {
          out.push({ ...at(index), specifier, why: 'work-hub/ alias outside plugin-api/' });
          continue;
        }
      } else continue; // npm package or node: builtin
      const rel = relative(root, target).split(sep).join('/');
      let why: string | null = null;
      if (rel.startsWith('server/') || rel.startsWith('web/src/') || rel === 'server' || rel === 'web/src') why = 'reaches into core (server/ or web/src/)';
      else if (!inside(target, pluginDir) && !inside(target, apiDir)) why = 'outside its plugin folder and plugin-api/';
      if (why) out.push({ ...at(index), specifier, why });
    }
  }
  return out;
}

/** Every boundary violation under `<root>/plugins`, in file then line order. */
export function checkImports(root: string): Violation[] {
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const out: Violation[] = [];
  for (const pluginName of readdirSync(pluginsDir).sort()) {
    const pluginDir = join(pluginsDir, pluginName);
    if (!statSync(pluginDir).isDirectory()) continue;
    out.push(...checkPluginImports(pluginDir, root));
  }
  return out;
}
