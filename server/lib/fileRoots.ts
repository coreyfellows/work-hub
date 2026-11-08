/** Folders plugins add to every session's file viewer scope (`ctx.files.addRoot`, e.g. adversarial review's reports), by plugin. */
const pluginRoots: Array<{ plugin: string; dir: string }> = [];

export function addFileRoot(dir: string, plugin: string): void {
  pluginRoots.push({ plugin, dir });
}

export function removeFileRoots(plugin: string): void {
  for (let i = pluginRoots.length - 1; i >= 0; i--) if (pluginRoots[i].plugin === plugin) pluginRoots.splice(i, 1);
}

/** Every folder plugins have added so far. */
export function fileRoots(): string[] {
  return pluginRoots.map((r) => r.dir);
}
