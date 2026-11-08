// The plugin import boundary: code under plugins/ may import only npm packages, files inside its own plugin folder and
// plugin-api/ (by relative path, or as `work-hub/plugin-api/...`). The other direction too: core code (server/, web/src/)
// never imports from plugins/ (the loader and the generated web module load them by path), so a plugin can be switched
// off or removed without breaking the core. Every plugins/*/plugin.json must also be a valid v1 manifest whose entry
// files exist. The checkers are run against a fixture first, so a broken regex can't pass silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repoRoot } from '../config.ts';
import { checkImports, checkPluginImports, inside, sourceFiles, SPECIFIER_RES, type Violation } from './boundary.ts';

export { checkImports, checkPluginImports, type Violation } from './boundary.ts';

/**
 * Core files allowed to name plugins/ paths, each with why. Keep this short: anything else that needs a plugin's code
 * belongs in that plugin (its own tests) or in plugin-api/.
 */
export const CORE_IMPORT_ALLOWED: Record<string, string> = {
  'web/src/plugins.generated.ts': 'the generated module that loads the active web plugins (gitignored)',
  'web/src/plugins.generated.example.ts': 'a commented example of that module',
  'server/plugins/generateWebModule.test.ts': "the generator's expected output (import lines as strings)",
  'server/security.test.ts': 'the real guard (core) with the real auth plugin: neither side may import the other',
  'server/plugins/boundary.test.ts': "this checker's own fixtures (import lines as strings)",
};

/** Every place a core file (under `<root>/server` or `<root>/web/src`) imports from `<root>/plugins`, outside `allowed`. */
export function checkCoreImports(root: string, allowed: Record<string, string> = CORE_IMPORT_ALLOWED): Violation[] {
  const pluginsDir = join(root, 'plugins');
  const out: Violation[] = [];
  for (const top of ['server', join('web', 'src')]) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      const rel = relative(root, file).split(sep).join('/');
      if (rel in allowed) continue;
      const text = readFileSync(file, 'utf8');
      const found = new Map<number, string>();
      for (const re of SPECIFIER_RES) for (const m of text.matchAll(re)) found.set(m.index, m[2]);
      for (const [index, specifier] of [...found].sort((a, b) => a[0] - b[0])) {
        const target =
          specifier.startsWith('.') || isAbsolute(specifier)
            ? resolve(dirname(file), specifier)
            : specifier.startsWith('work-hub/')
              ? resolve(root, specifier.slice('work-hub/'.length))
              : null;
        if (target && inside(target, pluginsDir)) {
          out.push({ file: rel, line: text.slice(0, index).split('\n').length, specifier, why: 'core imports from plugins/' });
        }
      }
    }
  }
  return out;
}

/** Problems with `<root>/plugins/<dir>/plugin.json` files: unparseable, wrong apiVersion, missing entry files. */
export function checkManifests(root: string): string[] {
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, 'plugin.json');
    if (!existsSync(file)) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      out.push(`plugins/${name}/plugin.json: ${(e as Error).message}`);
      continue;
    }
    if (typeof m.id !== 'string' || !m.id) out.push(`plugins/${name}/plugin.json: missing id`);
    if (m.apiVersion !== 1) out.push(`plugins/${name}/plugin.json: apiVersion is ${JSON.stringify(m.apiVersion)}, expected 1`);
    for (const key of ['server', 'web', 'claude', 'skills'] as const) {
      const entry = m[key];
      if (entry === undefined) continue;
      if (typeof entry !== 'string' || !existsSync(join(dir, entry))) out.push(`plugins/${name}/plugin.json: ${key} entry ${JSON.stringify(entry)} doesn't exist`);
    }
  }
  return out;
}

const describe = (vs: Violation[]) => vs.map((v) => `${v.file}:${v.line}: '${v.specifier}' (${v.why})`).join('\n');

test('the checker catches every kind of boundary violation (fixture)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-boundary-'));
  try {
    const w = (p: string, s: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), s);
    };
    w('plugin-api/server.ts', 'export {};\n');
    w('server/x.ts', 'export {};\n');
    w('plugins/b/y.ts', 'export {};\n');
    w(
      'plugins/a/server.ts',
      [
        "import type { X } from '../../plugin-api/server.ts';", // ok
        "import { z } from './lib/z.ts';", // ok
        "import { Hono } from 'hono';", // ok
        "import fs from 'node:fs';", // ok
        "import type { Y } from 'work-hub/plugin-api/server';", // ok
        "import { config } from '../../server/config.ts';", // 6: core
        "export { thing } from '../b/y.ts';", // 7: another plugin
        'import {',
        '  a,',
        "} from '../../web/src/api.ts';", // 10: core, multi-line
        "const m = await import('../../server/x.ts');", // 11: dynamic
        "import '../../server/side.ts';", // 12: side effect
        "import type { W } from 'work-hub/plugin-api/../server/x.ts';", // 13: alias escaping plugin-api
        "import type { V } from 'work-hub/server/x.ts';", // 14: alias to core
        "import '../../README.md';", // 15: repo file outside the plugin
      ].join('\n'),
    );
    w('plugins/a/lib/z.ts', "import { q } from '../../../plugin-api/server.ts';\nexport const z = 1;\n");
    const got = checkImports(root);
    assert.deepEqual(
      got.map((v) => [v.file, v.line, v.specifier]),
      [
        ['plugins/a/server.ts', 6, '../../server/config.ts'],
        ['plugins/a/server.ts', 7, '../b/y.ts'],
        ['plugins/a/server.ts', 10, '../../web/src/api.ts'],
        ['plugins/a/server.ts', 11, '../../server/x.ts'],
        ['plugins/a/server.ts', 12, '../../server/side.ts'],
        ['plugins/a/server.ts', 13, 'work-hub/plugin-api/../server/x.ts'],
        ['plugins/a/server.ts', 14, 'work-hub/server/x.ts'],
        ['plugins/a/server.ts', 15, '../../README.md'],
      ],
      describe(got),
    );

    w('plugins/a/plugin.json', JSON.stringify({ id: 'a', apiVersion: 1, title: 'A', defaultEnabled: true, server: 'server.ts', web: 'web.tsx' }));
    w('plugins/b/plugin.json', '{ nope');
    w('plugins/c/plugin.json', JSON.stringify({ id: 'c', apiVersion: 2, title: 'C', defaultEnabled: false }));
    const problems = checkManifests(root);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.equal(problems[0], `plugins/a/plugin.json: web entry "web.tsx" doesn't exist`);
    assert.match(problems[1], /^plugins\/b\/plugin\.json: /);
    assert.equal(problems[2], 'plugins/c/plugin.json: apiVersion is 2, expected 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the core-to-plugin checker catches server/ and web/src/ importing plugins/ (fixture)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-boundary-core-'));
  try {
    const w = (p: string, s: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), s);
    };
    w('plugins/a/edits.ts', 'export const x = 1;\n');
    w(
      'server/lib/t.test.ts',
      [
        "import { x } from '../../plugins/a/edits.ts';", // 1: static
        "import { y } from './y.ts';", // ok
        "const m = await import('../../plugins/a/edits.ts');", // 3: dynamic
        "import type { Z } from 'work-hub/plugins/a/edits.ts';", // 4: alias
        "import type { P } from '../../plugin-api/server.ts';", // ok: plugin-api is not plugins/
      ].join('\n'),
    );
    w('web/src/x.tsx', "import '../../plugins/a/styles.css';\n"); // 1: side effect
    w('web/src/gen.ts', "import p0 from '../../plugins/a/web.tsx';\n"); // allowed below
    const got = checkCoreImports(root, { 'web/src/gen.ts': 'generated' });
    assert.deepEqual(
      got.map((v) => [v.file, v.line, v.specifier]),
      [
        ['server/lib/t.test.ts', 1, '../../plugins/a/edits.ts'],
        ['server/lib/t.test.ts', 3, '../../plugins/a/edits.ts'],
        ['server/lib/t.test.ts', 4, 'work-hub/plugins/a/edits.ts'],
        ['web/src/x.tsx', 1, '../../plugins/a/styles.css'],
      ],
      describe(got),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('core code (server/, web/src/) never imports from plugins/', () => {
  const violations = checkCoreImports(repoRoot);
  assert.equal(violations.length, 0, `core imports from plugins/:\n${describe(violations)}`);
});

test('plugins/ imports only npm packages, their own files and plugin-api/', () => {
  const violations = checkImports(repoRoot);
  assert.equal(violations.length, 0, `plugin import boundary violations:\n${describe(violations)}`);
});

test('every plugins/*/plugin.json is a v1 manifest whose entry files exist', () => {
  const problems = checkManifests(repoRoot);
  assert.equal(problems.length, 0, problems.join('\n'));
});

test('checkPluginImports: a local plugin folder outside the checkout (fixture)', () => {
  const base = mkdtempSync(join(tmpdir(), 'wh-local-plugin-'));
  try {
    const root = join(base, 'work-hub');
    const local = join(base, 'mine');
    mkdirSync(join(root, 'plugin-api'), { recursive: true });
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, 'server.ts'),
      [
        "import type { ServerPluginContext } from '../work-hub/plugin-api/server.ts';",
        "import { x } from 'work-hub/plugin-api/server.ts';",
        "import { y } from './helpers.ts';",
        "import { z } from '../work-hub/server/config.ts';",
        "import { w } from 'work-hub/server/registry.ts';",
        "import { hono } from 'hono';",
      ].join('\n'),
    );
    const got = checkPluginImports(local, root, base);
    assert.deepEqual(
      got.map((v) => [v.file, v.line, v.why]),
      [
        ['mine/server.ts', 4, 'reaches into core (server/ or web/src/)'],
        ['mine/server.ts', 5, 'work-hub/ alias outside plugin-api/'],
      ],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
