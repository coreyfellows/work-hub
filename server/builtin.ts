/**
 * The app's own features that used to be plugins (builtin/<name>/): always on, not in Settings → Plugins, loaded before
 * the plugins through the same loader and `ServerPluginContext`. Their web halves are imported by web/src/builtin.ts.
 * Each has a manifest here instead of a plugin.json; the `settings` are what Settings shows for it.
 */
import { join } from 'node:path';
import { API_VERSION, type PluginManifest, type SettingDef } from '../plugin-api/manifest.ts';
import { SESSION_MODELS } from '../plugin-api/models.ts';
import type { ResolvedPlugin } from './plugins/resolve.ts';

const modelOptions = SESSION_MODELS.map((m) => ({ value: m, label: m }));

const sessionSettings: SettingDef[] = [
  {
    key: 'sessionModel',
    label: 'Default model for new sessions',
    description: 'Used for a session started by hand from a workspace when you pick "Auto" and it cannot decide, and as the form default.',
    type: 'select',
    options: modelOptions,
    default: 'opus',
    env: 'WORK_HUB_SESSION_MODEL',
  },
  {
    key: 'plannerModel',
    label: 'Model that picks the model ("Auto")',
    description: 'A quick headless run on this model rates the task and picks the session model and a name.',
    type: 'select',
    options: modelOptions,
    default: 'haiku',
    env: 'WORK_HUB_PLANNER_MODEL',
  },
  {
    key: 'plannerTimeoutMs',
    label: 'How long "Auto" may think (ms)',
    type: 'number',
    default: 60_000,
    min: 5_000,
    max: 600_000,
    env: 'WORK_HUB_PLANNER_TIMEOUT_MS',
  },
  {
    key: 'summaryTimeoutMs',
    label: 'How long a handoff brief may take (ms)',
    description: 'The brief is written by a headless fork of the session with its full context.',
    type: 'number',
    default: 300_000,
    min: 30_000,
    max: 3_600_000,
    env: 'WORK_HUB_HANDOFF_TIMEOUT_MS',
  },
  {
    key: 'handoffDir',
    label: 'Where handoff briefs are saved',
    type: 'string',
    placeholder: '<state dir>/handoffs',
    env: 'WORK_HUB_HANDOFF_DIR',
  },
];

const healthSettings: SettingDef[] = [
  {
    key: 'watchedMcp',
    label: 'MCP servers to watch',
    description: 'Comma-separated names. One that is failing or needs signing in shows as a health issue on the connection dot.',
    type: 'string',
    default: '',
    placeholder: 'e.g. github,linear',
    env: 'WORK_HUB_WATCHED_MCP',
    restart: true,
  },
  {
    key: 'githubHost',
    label: 'GitHub host for the sign-in check',
    description: 'Leave empty to use the GitHub plugin\'s host, else github.com.',
    type: 'string',
    placeholder: 'github.com',
    env: 'WORK_HUB_GH_HOST',
    restart: true,
  },
  {
    key: 'intervalMs',
    label: 'How often to check (ms)',
    type: 'number',
    default: 5 * 60_000,
    min: 30_000,
    max: 3_600_000,
    restart: true,
  },
];

const appRulesSettings: SettingDef[] = [
  {
    key: 'ruleCommands',
    label: 'Runnable commands and scripts',
    description: 'Claude hands you commands as one-line ! blocks (they get a Run button) and puts longer ones in a script that is non-interactive, a dry run by default, and never prints secrets.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'ruleQuestions',
    label: 'Follow-up questions',
    description: 'Claude asks next steps and decisions with the AskUserQuestion tool (answered inline, recommended option first, always a "Do nothing").',
    type: 'boolean',
    default: true,
  },
  {
    key: 'ruleVault',
    label: 'Vault login',
    description: 'How Claude asks you to sign in to Vault (a ! login command) and how scripts check for it. Off unless you use Vault with OIDC sign-in.',
    type: 'boolean',
    default: false,
  },
  {
    key: 'ruleNotes',
    label: 'Workspace notes',
    description: 'Claude records the commands it hands you and any manual steps in the workspace note.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'extraRules',
    label: 'Your own rules',
    description: 'Added to the end of every session work-hub starts (new sessions, handoffs, PR sessions, reviews), under "Your own rules". Applies to the next session you start; running ones keep what they had.',
    type: 'text',
    placeholder: 'e.g. Prefer small PRs. Always run the tests before saying you are done.',
  },
];

const BUILTINS: Array<Omit<PluginManifest, 'apiVersion' | 'defaultEnabled'>> = [
  {
    id: 'session-tools',
    title: 'Sessions',
    description: 'Starting, handing off and closing workspace sessions: which model they use and how it is picked.',
    server: 'server.ts',
    web: 'web.tsx',
    settings: sessionSettings,
    settingsOrder: 40,
  },
  {
    id: 'health',
    title: 'Health',
    description: 'Sign-in checks for claude and gh, MCP server status, and the connection dot\'s health issues.',
    server: 'server.ts',
    web: 'web.tsx',
    settings: healthSettings,
    settingsOrder: 50,
  },
  {
    id: 'session-stats',
    title: 'Session stats',
    description: "Tokens, API-equivalent cost and a Files changed modal under each session's header.",
    server: 'server.ts',
    web: 'web.tsx',
  },
  {
    id: 'app-rules',
    title: 'App rules',
    description: "The rules work-hub's features depend on (runnable ! commands, scripts, follow-up questions, notes, optionally Vault login), added to every session the app starts.",
    server: 'server.ts',
    claude: 'claude',
    settings: appRulesSettings,
    settingsOrder: 45,
  },
];

/** The built-in features as resolved, always-active plugins (their folders are `<repo>/builtin/<id>`). */
export function builtinPlugins(repoRoot: string): ResolvedPlugin[] {
  return BUILTINS.map((b) => ({
    manifest: { ...b, apiVersion: API_VERSION, defaultEnabled: true },
    dir: join(repoRoot, 'builtin', b.id),
    official: true,
    builtin: true,
    status: 'active' as const,
  }));
}
