import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The shared `work-hub` Claude Code plugin: skills that plugins list in their manifest (`skills`, a folder of skill
 * folders), offered in sessions as `/work-hub:<skill>`. The core keeps it at one fixed folder (`<state dir>/claude-plugin/
 * work-hub`) and passes it to every session the app starts (`--plugin-dir`, not to headless runs). At each startup the
 * folder's `skills/` is rebuilt to hold exactly the active plugins' skills (symlinks), so a plugin's skills exist only
 * while it is active, and `/reload-plugins` in a running session picks up what changed since it started.
 */

export const HUB_PLUGIN_NAME = 'work-hub';

export interface SkillSource {
  /** The plugin's id. */
  id: string;
  /** The plugin's folder. */
  dir: string;
  /** Its manifest's `skills` (relative to `dir`), if any. */
  skills?: string;
}

export interface HubSkillsResult {
  dir: string;
  /** Skill name → the plugin that provides it. */
  skills: Record<string, string>;
  /** Problems worth logging (a missing folder, a name two plugins use). */
  warnings: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Rebuild the plugin folder at `dir` from the active plugins' skills (first plugin wins a name). */
export function buildHubSkills(dir: string, active: SkillSource[]): HubSkillsResult {
  const warnings: string[] = [];
  const skills: Record<string, string> = {};
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: HUB_PLUGIN_NAME, version: '1.0.0', description: "work-hub's skills, from its active plugins (rebuilt when work-hub starts)" }, null, 2) + '\n',
  );
  const skillsDir = join(dir, 'skills');
  // The folder is the core's: clear it, then link what is active now.
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  for (const p of active) {
    if (!p.skills) continue;
    const src = resolve(p.dir, p.skills);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      warnings.push(`[plugin ${p.id}] skills folder ${p.skills} doesn't exist`);
      continue;
    }
    for (const name of readdirSync(src).sort()) {
      const from = join(src, name);
      if (!statSync(from).isDirectory() || !existsSync(join(from, 'SKILL.md'))) continue;
      if (!NAME.test(name)) {
        warnings.push(`[plugin ${p.id}] skill folder "${name}" isn't a valid skill name (lowercase letters, digits and -)`);
        continue;
      }
      if (skills[name]) {
        warnings.push(`[plugin ${p.id}] skill "${name}" is already provided by ${skills[name]}; skipped`);
        continue;
      }
      symlinkSync(from, join(skillsDir, name), 'dir');
      skills[name] = p.id;
    }
  }
  return { dir, skills, warnings };
}

/** For tests and the Status page: is `path` one of the links `buildHubSkills` makes? */
export const isSkillLink = (path: string) => existsSync(path) && lstatSync(path).isSymbolicLink();
