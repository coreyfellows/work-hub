// Checks a plugin folder against the import boundary (server/plugins/boundary.ts, the check official plugins get from
// boundary.test.ts): only npm packages, files inside the folder and work-hub's plugin-api/.
// Usage: pnpm check-plugin <plugin folder>   (exit 1 when something reaches into the core)
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '../server/config.ts';
import { checkPluginImports } from '../server/plugins/boundary.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: pnpm check-plugin <plugin folder>');
  process.exit(2);
}
const dir = resolve(arg);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`not a folder: ${dir}`);
  process.exit(2);
}
const violations = checkPluginImports(dir, repoRoot, dir);
for (const v of violations) console.log(`${v.file}:${v.line}: '${v.specifier}' (${v.why})`);
if (violations.length) {
  console.log(`${violations.length} import(s) outside the plugin folder and plugin-api/`);
  process.exit(1);
}
console.log(`ok: ${dir} imports only npm packages, its own files and plugin-api/`);
