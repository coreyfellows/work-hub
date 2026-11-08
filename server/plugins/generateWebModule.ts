/**
 * Writes `web/src/plugins.generated.ts`: one static import per active plugin with a `web` entry (plus its `styles.css`
 * when there is one), each called with its `WebPluginContext`, and the core's layout overrides CSS last so the core
 * breakpoints win over plugin CSS. Uses the same discover → resolve steps as the server loader, so the web half and the
 * server half of the app always agree on which plugins are on. Run by the Vite plugin (dev and build) and by
 * `scripts/gen-plugins.ts` (before typecheck/test on a fresh clone). Pure Node: no Vite, no app state.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readPluginsConfig, type PluginsConfig } from './config.ts';
import { discoverPlugins } from './discover.ts';
import { loadOrder } from './loader.ts';
import { resolvePlugins, type ResolvedPlugin } from './resolve.ts';

export interface GenerateOptions {
  /** plugins.json (missing = defaults). */
  pluginsFile: string;
  /** The repo's own plugins/ folder. */
  officialDir: string;
  /** The module to write (web/src/plugins.generated.ts). */
  outFile: string;
  /** web/src/layout-overrides.css, imported last. */
  overridesCss: string;
  /**
   * Where active plugins' `webEntries` pages are written (web/plugin-entries; gitignored): `<name>.html` plus one
   * `<name>.entry<i>.ts` per module script, importing the plugin's own file. Vite builds them to
   * `dist/plugin-entries/<name>.html`. Unset: entries are ignored.
   */
  entriesDir?: string;
  /** Where problems go (default console.warn). */
  log?: (msg: string) => void;
}

export interface GeneratedEntry {
  plugin: string;
  /** The page name (`webEntries` key): built to `plugin-entries/<name>.html`. */
  name: string;
  /** The generated HTML file (a Vite input). */
  html: string;
}

export interface GeneratedPlugin {
  id: string;
  dir: string;
  official: boolean;
  /** Absolute path of the web entry. */
  web: string;
  /** Absolute path of styles.css, when the plugin has one. */
  css?: string;
}

export interface GenerateResult {
  plugins: GeneratedPlugin[];
  /** Active plugins' extra HTML pages (`webEntries`), for Vite's build inputs. */
  entries: GeneratedEntry[];
  /** False when the file already had this content (left untouched, so Vite's watcher stays calm). */
  written: boolean;
  /** plugins.json problems and resolver errors (the module is still written, from defaults). */
  errors: string[];
}

/** Official plugins by a path relative to the generated file (portable across checkouts); local ones by absolute path. */
function specifier(file: string, official: boolean, fromDir: string): string {
  if (!official) return file;
  const rel = relative(fromDir, file).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Write `content` unless the file already has it (Vite's watcher stays calm). True if written. */
function writeIfChanged(file: string, content: string): boolean {
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* not there yet */
  }
  if (current === content) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

const ENTRY_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A plugin's extra page, copied into `entriesDir` with each relative `<script type="module" src>` pointing at a small
 * generated module that imports the plugin's file (so it resolves the same in dev and build, wherever the plugin lives).
 */
function writeEntries(plugins: ResolvedPlugin[], entriesDir: string, errors: string[]): GeneratedEntry[] {
  const entries: GeneratedEntry[] = [];
  const keep = new Set<string>();
  const seen = new Map<string, string>();
  for (const p of plugins) {
    for (const [name, file] of Object.entries(p.manifest.webEntries ?? {})) {
      const id = p.manifest.id;
      if (!ENTRY_NAME.test(name)) {
        errors.push(`plugin ${id}: webEntries name "${name}" must be lowercase letters, digits and dashes`);
        continue;
      }
      if (seen.has(name)) {
        errors.push(`plugin ${id}: webEntries "${name}" is already plugin ${seen.get(name)}'s`);
        continue;
      }
      // The page and every script it loads must be files inside the plugin's own folder (after symlinks).
      const inside = (path: string): string => {
        const real = realpathSync(path); // also throws if it doesn't exist
        const rel = relative(realpathSync(p.dir), real);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path} is outside the plugin folder`);
        return path;
      };
      let src: string;
      let html: string;
      try {
        src = inside(join(p.dir, file));
        html = readFileSync(src, 'utf8');
      } catch (e) {
        errors.push(`plugin ${id}: webEntries "${name}": can't use ${file} (${(e as Error).message})`);
        continue;
      }
      const SCRIPT = /(<script\b[^>]*\btype="module"[^>]*\bsrc=")([^"]+)(")/g;
      const targets = new Map<string, string>();
      let bad: string | null = null;
      for (const m of html.matchAll(SCRIPT)) {
        const ref = m[2]!;
        if (/^(?:[a-z]+:|\/)/i.test(ref)) continue; // absolute URLs and root paths stay as they are
        try {
          targets.set(ref, inside(join(dirname(src), ref)));
        } catch (e) {
          bad = `script ${ref}: ${(e as Error).message}`;
          break;
        }
      }
      if (bad) {
        errors.push(`plugin ${id}: webEntries "${name}": ${bad}`);
        continue;
      }
      seen.set(name, id);
      let i = 0;
      html = html.replace(SCRIPT, (all, pre: string, ref: string, post: string) => {
        const target = targets.get(ref);
        if (!target) return all;
        const mod = `${name}.entry${i++}.ts`;
        writeIfChanged(join(entriesDir, mod), `// Generated from plugin ${id}'s webEntries "${name}": do not edit.\nimport ${q(specifier(target, p.official, entriesDir))};\n`);
        keep.add(mod);
        return `${pre}./${mod}${post}`;
      });
      const out = join(entriesDir, `${name}.html`);
      writeIfChanged(out, html);
      keep.add(`${name}.html`);
      entries.push({ plugin: id, name, html: out });
    }
  }
  // Pages of plugins that are off now: gone, so nothing serves a stale copy.
  if (existsSync(entriesDir)) {
    for (const f of readdirSync(entriesDir)) if (!keep.has(f)) rmSync(join(entriesDir, f), { force: true });
  }
  return entries;
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function generateWebModule(opts: GenerateOptions): GenerateResult {
  const log = opts.log ?? ((m: string) => console.warn(`plugins: ${m}`));
  const errors: string[] = [];
  let cfg: PluginsConfig;
  try {
    cfg = readPluginsConfig(opts.pluginsFile);
  } catch (e) {
    errors.push((e as Error).message);
    cfg = { local: [], enabled: {} };
  }
  const resolution = resolvePlugins(discoverPlugins(opts.officialDir, cfg.local), cfg);
  errors.push(...resolution.errors);
  for (const e of errors) log(e);

  const ordered = loadOrder(resolution.plugins);
  const entryErrors: string[] = [];
  const entries = opts.entriesDir ? writeEntries(ordered, opts.entriesDir, entryErrors) : [];
  for (const e of entryErrors) log(e);
  errors.push(...entryErrors);
  const plugins: GeneratedPlugin[] = [];
  for (const p of ordered) {
    if (!p.manifest.web) continue;
    const web = join(p.dir, p.manifest.web);
    // A typo in a manifest's `web` would otherwise fail the whole build on an unresolvable import.
    if (!existsSync(web)) {
      const msg = `plugin ${p.manifest.id}: its "web" entry ${p.manifest.web} doesn't exist (${web}); its web half is left out`;
      log(msg);
      errors.push(msg);
      continue;
    }
    const css = join(p.dir, 'styles.css');
    plugins.push({ id: p.manifest.id, dir: p.dir, official: p.official, web, ...(existsSync(css) ? { css } : {}) });
  }

  const from = dirname(opts.outFile);
  const lines = [
    '// Generated by server/plugins/generateWebModule.ts from the active plugins: do not edit (it is rewritten on every dev',
    '// start and build). See plugins.generated.example.ts for the shape.',
    `import { createWebContext } from './pluginContext.ts';`,
  ];
  plugins.forEach((p, i) => {
    lines.push(`import p${i} from ${q(specifier(p.web, p.official, from))};`);
    if (p.css) lines.push(`import ${q(specifier(p.css, p.official, from))};`);
    lines.push(`p${i}(createWebContext(${q(p.id)}));`);
  });
  lines.push(`import ${q(specifier(opts.overridesCss, true, from))};`);
  const content = lines.join('\n') + '\n';

  const written = writeIfChanged(opts.outFile, content);
  return { plugins, entries, written, errors };
}
