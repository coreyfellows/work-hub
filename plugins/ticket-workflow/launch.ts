/**
 * Loading the bundled Claude plugin into the sessions work-hub starts (`--plugin-dir`), unless the user already has a
 * plugin of the same name at user scope (the core's `ctx.claude.pluginInstalled`): then their own copy is in every
 * session already, and `--plugin-dir` would replace it (Claude Code loads an inline plugin instead of an installed one
 * of the same name).
 */

/** The launch-args function: `--plugin-dir <dir>` unless the user's own copy is installed. */
export function pluginDirArgs(dir: string, installed: () => Promise<boolean>): () => Promise<string[]> {
  return async () => ((await installed()) ? [] : ['--plugin-dir', dir]);
}
