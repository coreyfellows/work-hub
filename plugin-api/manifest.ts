export const API_VERSION = 1;

export type SettingValue = string | number | boolean;

/**
 * One editable setting, shown in Settings under its plugin's title and stored in the app's database (`app_settings`,
 * key `<plugin id>.<key>`). `ctx.config.get(key, default)` reads it: the env var wins, then plugins.json `settings`,
 * then what Settings stored, then the default. The page shows the value in force and where it comes from.
 */
export interface SettingDef {
  key: string;
  label: string;
  description?: string;
  type: 'string' | 'text' | 'number' | 'boolean' | 'select';
  /** What applies when nothing is set (also what "Reset" restores). Shown as the placeholder for strings. */
  default?: SettingValue;
  /** For `select`. */
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  placeholder?: string;
  /** The plugin reads it once (at startup, or when its own daemon starts), so a change needs a restart: Settings says so. */
  restart?: boolean;
  /** An env var that overrides it (default `WORK_HUB_<PLUGIN>_<KEY>`; the core's own settings name theirs). */
  env?: string;
  /** Ask for it on the app's first-run page (only while it has no value; settings sharing an `env` are asked once). */
  firstRun?: boolean;
}

export interface PluginManifest {
  id: string;
  apiVersion: number;
  title: string;
  description?: string;
  defaultEnabled: boolean;
  /** Id of another plugin this one stands in for (hides it while this one is enabled). */
  replaces?: string;
  /** Ids of plugins that must be active for this one to load. */
  requires?: string[];
  /** Entry files, relative to the plugin folder. */
  server?: string;
  web?: string;
  /**
   * Informational: the plugin's Claude Code plugin folder, if it bundles one. The core doesn't read it; a plugin that
   * wants sessions to load the folder passes it itself (`ctx.sessions.addLaunchArgs` → `--plugin-dir`).
   */
  claude?: string;
  /**
   * Extra HTML pages built beside the app (name → HTML file in the plugin folder), e.g. `{ "login": "login.html" }`.
   * Each is built to `dist/plugin-entries/<name>.html` while the plugin is active; the plugin serves it itself. Its
   * `<script type="module" src="./x.ts">` tags are resolved against the plugin folder.
   */
  webEntries?: Record<string, string>;
  /**
   * A folder (relative to the plugin's) of Claude Code skill folders (`<name>/SKILL.md`). While the plugin is active, the
   * core links each into its shared `work-hub` Claude plugin, which every session the app starts loads, so a skill
   * `foo` is `/work-hub:foo` there. Inside a skill, `${CLAUDE_PLUGIN_ROOT}/skills/<name>/` is the skill's own folder.
   */
  skills?: string;
  /**
   * The Claude Code version (`x.y.z`) this plugin was last brought up to date with. The claude-monitor plugin only
   * suggests changes from newer Claude Code releases; a session that updates the plugin for a release sets it. Optional,
   * informational for the core.
   */
  claudeVersion?: string;
  /** Former ids, so existing config keyed by an old id still applies. */
  aliases?: string[];
  /** Settings the plugin offers; Settings shows them as a section titled with the plugin's title. */
  settings?: SettingDef[];
  /** Where that section sits among Settings' sections (default 70: after Plugins; the core's are 20 to 60). */
  settingsOrder?: number;
  /**
   * Offer this plugin on the app's first-run page while it is off: a checkbox with `label` and `description` that turns
   * it on (plugins.json `enabled`; applies after a rebuild and restart), and optionally one question (`ask.key`, one of
   * the plugin's own string `settings`) whose answer is stored like that setting.
   */
  firstRunOffer?: { label: string; description?: string; ask?: { key: string; label: string; placeholder?: string } };
}
