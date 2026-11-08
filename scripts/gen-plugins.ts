// Writes web/src/plugins.generated.ts (and web/plugin-entries/, the plugins' extra pages) from the active plugins (the Vite plugin does the same on dev/build); run
// before typecheck and tests so a fresh clone has the file. Honours WORK_HUB_PLUGINS_FILE / WORK_HUB_CONFIG_DIR.
import { join } from 'node:path';
import { config, repoRoot } from '../server/config.ts';
import { generateWebModule } from '../server/plugins/generateWebModule.ts';

export function genPlugins() {
  return generateWebModule({
    pluginsFile: config.pluginsFile,
    officialDir: config.officialPluginsDir,
    outFile: join(repoRoot, 'web', 'src', 'plugins.generated.ts'),
    overridesCss: join(repoRoot, 'web', 'src', 'layout-overrides.css'),
    entriesDir: join(repoRoot, 'web', 'plugin-entries'),
  });
}

if (import.meta.main) {
  const r = genPlugins();
  console.log(`plugins.generated.ts: ${r.plugins.length} web plugin${r.plugins.length === 1 ? '' : 's'}${r.written ? '' : ' (unchanged)'}`);
}
