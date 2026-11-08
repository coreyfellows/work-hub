/**
 * The pure parts of "Create plugin": checking the form, working out where a local plugin goes, the branch slug, and the
 * prompt the author session starts with. No I/O here (the route in server.ts passes in what it read), so all of it is
 * unit-tested.
 */
import { isAbsolute, join, normalize, sep } from 'node:path';
import { NAME_RE } from './name.ts';

export { NAME_RE };

export interface CreateInput {
  /** The plugin id the user asked for; null: the session picks one. */
  name: string | null;
  official: boolean;
  /** Official only (manifest `defaultEnabled`); local plugins are always `true` (the user turns them on themselves). */
  defaultEnabled: boolean;
  /** Local only: an absolute, normalized folder (a listed folder of plugins, or the plugin's own folder). */
  destination: string | null;
  description: string;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A path without a trailing separator (`normalize` keeps one), so `/a/b/` and `/a/b` compare equal. */
export function cleanPath(p: string): string {
  const n = normalize(p.trim());
  return n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
}

/**
 * Check the Create form's body. `taken`: every plugin id and alias found, built-ins included; `officialAvailable`: the
 * app runs from a git checkout; `repoRoot`: that checkout (a local plugin may not land inside it, where it'd be tracked).
 */
export function validateCreate(body: unknown, opts: { taken: Set<string>; officialAvailable: boolean; repoRoot: string }): Result<{ input: CreateInput }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'expected a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.official !== 'boolean') return { ok: false, error: 'official: expected true or false' };
  if (b.defaultEnabled !== undefined && typeof b.defaultEnabled !== 'boolean') return { ok: false, error: 'defaultEnabled: expected true or false' };
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!description) return { ok: false, error: 'Describe what the plugin should do.' };

  let name: string | null = null;
  if (b.name !== undefined && b.name !== null) {
    if (typeof b.name !== 'string') return { ok: false, error: 'name: expected a string' };
    name = b.name.trim() || null;
  }
  if (name !== null) {
    if (!NAME_RE.test(name)) return { ok: false, error: `Name "${name}": use lowercase letters, digits and dashes, starting with a letter.` };
    if (name === 'core') return { ok: false, error: 'The id "core" is reserved for the core.' };
    if (opts.taken.has(name)) return { ok: false, error: `"${name}" is already a plugin id (or a former one); pick another name.` };
  }

  if (b.official) {
    if (!opts.officialAvailable) return { ok: false, error: 'Official plugins need the app to run from a git checkout of work-hub; make it a local plugin.' };
    return { ok: true, input: { name, official: true, defaultEnabled: b.defaultEnabled !== false, destination: null, description } };
  }

  const raw = typeof b.destination === 'string' ? b.destination.trim() : '';
  if (!raw) return { ok: false, error: 'Pick where to put the plugin.' };
  if (!isAbsolute(raw)) return { ok: false, error: `Destination must be an absolute path: ${raw}` };
  const destination = cleanPath(raw);
  const root = cleanPath(opts.repoRoot);
  if (destination === root || destination.startsWith(root + sep)) {
    return { ok: false, error: 'That folder is inside work-hub: turn on Official for a plugin in the repo, or pick a folder outside it.' };
  }
  return { ok: true, input: { name, official: false, defaultEnabled: true, destination, description } };
}

/** What's at a path: nothing, an empty folder, a folder with something in it, or anything else. */
export type PathKind = 'missing' | 'empty-dir' | 'dir' | 'file';

export interface Destination {
  /** Passed to the session as `--add-dir`. */
  addDir: string;
  /** Where the plugin's files go; null: `<folder>/<id>`, the id the session picks. */
  pluginDir: string | null;
  /** The listed folder of plugins it goes into; null: `pluginDir` is a new folder of its own (to add to `local`). */
  folder: string | null;
  /** The folder the route makes (if missing) before the session starts, so `--add-dir` has something to point at. */
  create: string;
}

const occupied = (k: PathKind) => k === 'dir' || k === 'file';

/**
 * Where a local plugin goes. A destination listed in plugins.json `local` as a folder of plugins (`folders`) gets the
 * plugin in `<destination>/<id>/`; anything else is the plugin's own folder, which must not exist yet or be empty.
 */
export function resolveDestination(input: { destination: string; name: string | null }, opts: { folders: string[]; kind: (p: string) => PathKind }): Result<{ dest: Destination }> {
  const d = cleanPath(input.destination);
  if (opts.folders.map(cleanPath).includes(d)) {
    const pluginDir = input.name ? join(d, input.name) : null;
    if (pluginDir && occupied(opts.kind(pluginDir))) return { ok: false, error: `${pluginDir} already exists and isn't empty; pick another name.` };
    return { ok: true, dest: { addDir: d, pluginDir, folder: d, create: d } };
  }
  const k = opts.kind(d);
  if (k === 'file') return { ok: false, error: `${d} is not a folder.` };
  if (k === 'dir') {
    return {
      ok: false,
      error: `${d} already exists and isn't empty. To put plugins inside it, add it under Settings → Plugins → Local plugin folders first; or pick a new folder.`,
    };
  }
  return { ok: true, dest: { addDir: d, pluginDir: d, folder: null, create: d } };
}

/** The worktree's folder and branch suffix (`plugin-<slug>`): the name, else the description's first words plus `rand`. */
export function branchSlug(name: string | null, description: string, rand: string): string {
  if (name) return name;
  const words = description.trim().split(/\s+/).slice(0, 4).join(' ');
  const kebab = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '');
  return kebab ? `${kebab}-${rand}` : `new-${rand}`;
}

export interface AuthorPromptOpts {
  workspaceId: string;
  input: CreateInput;
  /** Local only. */
  dest: Destination | null;
  /** The work-hub worktree the session runs in. */
  worktree: string;
  branch: string;
  base: string;
  /** The checkout the app runs from (`ctx.paths.repoRoot`). */
  appRepo: string;
  /** plugins.json (`ctx.plugins.configFile`). */
  configFile: string;
  whCommand: string;
  /** The core's workspace rules (`ctx.prompts.workspaceRules`), appended last. */
  rules: string[];
}

/** The author session's first prompt: what to build, where, the plugin-API rules, how to finish; then the workspace rules. */
export function authorPrompt(o: AuthorPromptOpts): string {
  const { input, dest } = o;
  const WH = o.whCommand;
  const idLine = input.name
    ? `Its id is \`${input.name}\` (already checked: no other plugin uses it).`
    : 'Pick a short kebab-case id for it (`^[a-z][a-z0-9-]*$`) that no plugin uses yet: check the ids and aliases in `GET /api/plugins` and the folders under `plugins/` and the local plugin folders. `core` is reserved.';
  const id = input.name ?? '<id>';

  const where = input.official
    ? [
        `It is an **official** plugin: write it in this worktree as \`${o.worktree}/plugins/${id}/\` with \`"defaultEnabled": ${input.defaultEnabled}\` in its plugin.json.`,
        '',
        'Official checklist:',
        `- \`plugins/${id}/plugin.json\` (\`apiVersion\` 1), its \`server.ts\` and/or \`web.tsx\` (and \`styles.css\` if it has CSS), a \`README.md\` (what it does, routes, slots, settings with key/env/default, caveats) and tests (\`plugins/${id}/*.test.ts\`).`,
        '- A row for it in the Official plugins table in `CLAUDE.md`.',
        '- Imports: npm packages, its own files and `plugin-api/*` only (`server/plugins/boundary.test.ts` checks).',
      ]
    : [
        dest?.pluginDir
          ? `It is a **local** plugin: write it in \`${dest.pluginDir}\` (it exists and is empty; you can write there without prompts).`
          : `It is a **local** plugin: write it in a new folder \`${dest?.folder ?? '<folder>'}/<id>/\`, inside the folder of plugins \`${dest?.folder ?? '<folder>'}\` (you can write there without prompts).`,
        '',
        'Local checklist (`docs/plugins.md` is the guide):',
        `- \`plugin.json\` with \`"apiVersion": 1\` and \`"defaultEnabled": true\`, its entry files, a \`README.md\` and tests if the folder's repo runs any.`,
        '- Import the plugin API as types only in `server.ts` (`import type … from \'work-hub/plugin-api/server\'`); web code may import `work-hub/plugin-api/web`.',
        dest?.folder
          ? `- plugins.json (\`${o.configFile}\`): \`${dest.folder}\` is already in \`local\`; set \`"enabled": { "${id}": true }\` (keep everything else in the file).`
          : `- plugins.json (\`${o.configFile}\`; create it if missing): add \`${dest?.pluginDir ?? '<folder>'}\` to \`local\` and set \`"enabled": { "${id}": true }\` (keep everything else in the file).`,
        `- Run \`pnpm check-plugin ${dest?.pluginDir ?? `${dest?.folder ?? '<folder>'}/<id>`}\` from this worktree (imports outside \`plugin-api\` are a problem).`,
        `- This worktree (\`${o.worktree}\`) is for any work-hub core change the plugin needs. If it needs none, leave the worktree clean.`,
      ];

  return [
    `You're building a new work-hub plugin, in workspace "${o.workspaceId}". What it should do, in the user's words:`,
    '',
    input.description,
    '',
    idLine,
    ...where,
    '',
    `You are in a work-hub worktree, \`${o.worktree}\`, on branch \`${o.branch}\` (from \`${o.base}\`). The app itself runs from \`${o.appRepo}\`: never edit files there.`,
    '',
    'Read first: `CLAUDE.md`, `docs/plugins.md`, `plugin-api/*.ts` (manifest, server, web), `CHANGELOG.md`, and one or two official plugins that do something similar. If the description leaves a real choice open (what it shows, where, how often it polls), ask me before building.',
    '',
    'Plugin-API rules:',
    '- Extend the plugin API as it exists; prefer additive changes (a new `ctx` member, an optional field, a new slot or helper). Put each addition under "Additions" in `CHANGELOG.md`, marked additive, without bumping `apiVersion`.',
    '- Only if an additive change is impossible, a breaking one. First ask me with AskUserQuestion, in a question plainly labelled as a **significant plugin-API change**: what breaks, why additive won\'t do, and who has to migrate (official plugins and everyone\'s local plugins). Only on my yes: bump `apiVersion`, migrate every official plugin in the same change, add a "Plugin API <n>" entry with migration steps to `CHANGELOG.md` (its template is under "Migrating"), and repeat the warning at the top of your final report.',
    '- Otherwise you may change any work-hub behaviour the plugin needs, as long as the official plugins still work and look basically the same.',
    '- Follow everything else in `CLAUDE.md`: the core vs plugins split, low data, no sideways scrolling at 375px, the confirm rule, localhost-first security, jobs for slow work, no plugin knobs in `server/config.ts`.',
    '',
    'Finishing:',
    '- Run `pnpm typecheck` and `pnpm test` in this worktree (and `pnpm build` if there is web code) until they pass.',
    '- Commit and push by each repo\'s own rules (its CLAUDE.md, or CONTRIBUTING). A repo with no rules: commit on a branch, push if it has a remote, and ask me before merging.',
    `- Going live: once the checks pass, ask me with AskUserQuestion whether to rebuild and restart now, unless the repo's rules say to deploy (then follow them). ${input.official ? `The plugin must first be on the branch \`${o.appRepo}\` runs, by the repo's merge rules.` : 'If you changed work-hub itself, that change must first be on the branch the app runs, by the repo\'s merge rules.'} Restart with \`scripts/update.sh --no-pull\` run from \`${o.appRepo}\` (the same as Settings → Plugins → Apply now).`,
    `- Record as you go: \`${WH} link add ${o.workspaceId} --url <url>\` for a PR or repo, and \`${WH} note ${o.workspaceId} "<one-paragraph plan>"\` once you have a plan.`,
    '- Final report: what you built and where, whether the plugin API changed (additive or breaking, said prominently), and how to turn it on.',
    '',
    ...o.rules,
  ].join('\n');
}
