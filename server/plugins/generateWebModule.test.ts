import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_VERSION } from '../../plugin-api/manifest.ts';
import { generateWebModule } from './generateWebModule.ts';

/** A fake repo: <root>/plugins (official), <root>/web/src (the generated file's home), <root>/local (local plugins). */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wh-genweb-'));
  const officialDir = join(root, 'plugins');
  const webSrc = join(root, 'web', 'src');
  mkdirSync(webSrc, { recursive: true });
  const plugin = (dir: string, manifest: Record<string, unknown>, files: string[] = []) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ apiVersion: API_VERSION, title: 'x', defaultEnabled: true, ...manifest }));
    for (const f of files) writeFileSync(join(dir, f), '');
  };
  return {
    root,
    officialDir,
    outFile: join(webSrc, 'plugins.generated.ts'),
    overridesCss: join(webSrc, 'layout-overrides.css'),
    pluginsFile: join(root, 'config', 'plugins.json'),
    plugin,
    config(cfg: unknown) {
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, 'config', 'plugins.json'), JSON.stringify(cfg));
    },
  };
}

test('no plugins: the context import and the overrides CSS only', () => {
  const s = setup();
  const r = generateWebModule(s);
  assert.deepEqual(r.plugins, []);
  const out = readFileSync(s.outFile, 'utf8');
  const code = out.split('\n').filter((l) => l && !l.startsWith('//'));
  assert.deepEqual(code, [`import { createWebContext } from './pluginContext.ts';`, `import './layout-overrides.css';`]);
});

test('active official plugins with a web entry, CSS when styles.css exists, overrides last', () => {
  const s = setup();
  s.plugin(join(s.officialDir, 'alpha'), { id: 'alpha', web: 'web.tsx' }, ['web.tsx', 'styles.css']);
  s.plugin(join(s.officialDir, 'beta'), { id: 'beta', web: 'web.tsx' }, ['web.tsx']);
  s.plugin(join(s.officialDir, 'gamma'), { id: 'gamma', server: 'server.ts' }, ['server.ts']); // no web entry
  s.plugin(join(s.officialDir, 'delta'), { id: 'delta', web: 'web.tsx', defaultEnabled: false }, ['web.tsx']); // off
  s.plugin(join(s.officialDir, 'eps'), { id: 'eps', web: 'web.tsx', apiVersion: 99 }, ['web.tsx']); // skipped
  const r = generateWebModule(s);
  assert.deepEqual(r.plugins.map((p) => p.id), ['alpha', 'beta']);
  const out = readFileSync(s.outFile, 'utf8');
  const code = out.split('\n').filter((l) => l && !l.startsWith('//'));
  assert.deepEqual(code, [
    `import { createWebContext } from './pluginContext.ts';`,
    `import p0 from '../../plugins/alpha/web.tsx';`,
    `import '../../plugins/alpha/styles.css';`,
    `p0(createWebContext('alpha'));`,
    `import p1 from '../../plugins/beta/web.tsx';`,
    `p1(createWebContext('beta'));`,
    `import './layout-overrides.css';`,
  ]);
});

test('local plugins by absolute path; replaced plugins and disabled ones are left out', () => {
  const s = setup();
  const local = join(s.root, 'local');
  s.plugin(join(s.officialDir, 'base'), { id: 'base', web: 'web.tsx' }, ['web.tsx']);
  s.plugin(join(local, 'mine'), { id: 'mine', web: 'ui/web.tsx', replaces: 'base' }, ['styles.css']);
  mkdirSync(join(local, 'mine', 'ui'), { recursive: true });
  writeFileSync(join(local, 'mine', 'ui', 'web.tsx'), '');
  s.plugin(join(local, 'other'), { id: 'other', web: 'web.tsx' }, ['web.tsx']);
  s.config({ local: [local], enabled: { other: false } });
  const r = generateWebModule(s);
  assert.deepEqual(r.plugins.map((p) => [p.id, p.official]), [['mine', false]]);
  assert.equal(r.plugins[0]!.dir, join(local, 'mine'));
  const out = readFileSync(s.outFile, 'utf8');
  assert.ok(out.includes(`import p0 from '${join(local, 'mine', 'ui', 'web.tsx')}';`), out);
  assert.ok(out.includes(`import '${join(local, 'mine', 'styles.css')}';`), out);
  assert.ok(!out.includes('base/web.tsx'));
  assert.ok(!out.includes('file://'));
});

test('a plugin comes after the plugins it requires', () => {
  const s = setup();
  s.plugin(join(s.officialDir, 'a-needs-z'), { id: 'a-needs-z', web: 'web.tsx', requires: ['z'] }, ['web.tsx']);
  s.plugin(join(s.officialDir, 'z'), { id: 'z', web: 'web.tsx' }, ['web.tsx']);
  assert.deepEqual(generateWebModule(s).plugins.map((p) => p.id), ['z', 'a-needs-z']);
});

test('a plugin whose web file is missing is left out with a clear error; the rest still generate', () => {
  const s = setup();
  s.plugin(join(s.officialDir, 'alpha'), { id: 'alpha', web: 'web.tsx' }, ['web.tsx']);
  s.plugin(join(s.officialDir, 'typo'), { id: 'typo', web: 'wbe.tsx' }, ['web.tsx']);
  const logged: string[] = [];
  const r = generateWebModule({ ...s, log: (m) => logged.push(m) });
  assert.deepEqual(r.plugins.map((p) => p.id), ['alpha']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /^plugin typo: its "web" entry wbe\.tsx doesn't exist \(.*typo\/wbe\.tsx\); its web half is left out$/);
  assert.deepEqual(logged, r.errors);
  assert.doesNotMatch(readFileSync(s.outFile, 'utf8'), /typo/);
});

test('writes only when the content changes', async () => {
  const s = setup();
  assert.equal(generateWebModule(s).written, true);
  const m1 = statSync(s.outFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(generateWebModule(s).written, false);
  assert.equal(statSync(s.outFile).mtimeMs, m1);
  s.plugin(join(s.officialDir, 'alpha'), { id: 'alpha', web: 'web.tsx' }, ['web.tsx']);
  assert.equal(generateWebModule(s).written, true);
});

test('a broken plugins.json falls back to defaults instead of failing the build', () => {
  const s = setup();
  s.plugin(join(s.officialDir, 'alpha'), { id: 'alpha', web: 'web.tsx' }, ['web.tsx']);
  mkdirSync(join(s.root, 'config'), { recursive: true });
  writeFileSync(s.pluginsFile, '{nope');
  const r = generateWebModule({ ...s, log: () => {} });
  assert.deepEqual(r.plugins.map((p) => p.id), ['alpha']);
  assert.ok(existsSync(s.outFile));
  assert.equal(r.errors.length, 1);
});

test('webEntries: an active plugin page is copied with its module scripts pointing at generated imports; off plugins leave none', () => {
  const s = setup();
  const entriesDir = join(s.root, 'web', 'plugin-entries');
  const dir = join(s.officialDir, 'gate');
  s.plugin(dir, { id: 'gate', defaultEnabled: false, webEntries: { login: 'login.html' } }, ['login.ts']);
  writeFileSync(join(dir, 'login.html'), '<p>hi</p><script type="module" src="./login.ts"></script><script type="module" src="/keep.js"></script>');

  // Off: no entries, and a stale page from an earlier run is removed.
  mkdirSync(entriesDir, { recursive: true });
  writeFileSync(join(entriesDir, 'login.html'), 'stale');
  assert.deepEqual(generateWebModule({ ...s, entriesDir }).entries, []);
  assert.ok(!existsSync(join(entriesDir, 'login.html')));

  s.config({ enabled: { gate: true } });
  const r = generateWebModule({ ...s, entriesDir });
  assert.deepEqual(r.entries, [{ plugin: 'gate', name: 'login', html: join(entriesDir, 'login.html') }]);
  const html = readFileSync(join(entriesDir, 'login.html'), 'utf8');
  assert.equal(html, '<p>hi</p><script type="module" src="./login.entry0.ts"></script><script type="module" src="/keep.js"></script>');
  assert.match(readFileSync(join(entriesDir, 'login.entry0.ts'), 'utf8'), /^import '\.\.\/\.\.\/plugins\/gate\/login\.ts';$/m);
});

test('webEntries: a bad name or a name another plugin took is an error, not a page', () => {
  const s = setup();
  const entriesDir = join(s.root, 'web', 'plugin-entries');
  s.plugin(join(s.officialDir, 'a'), { id: 'a', webEntries: { login: 'p.html', 'Bad Name': 'p.html' } }, ['p.html']);
  s.plugin(join(s.officialDir, 'b'), { id: 'b', webEntries: { login: 'p.html' } }, ['p.html']);
  const r = generateWebModule({ ...s, entriesDir, log: () => {} });
  assert.deepEqual(r.entries.map((e) => `${e.plugin}:${e.name}`), ['a:login']);
  assert.equal(r.errors.length, 2);
});

test('webEntries: a page or a script outside the plugin folder is an error, and no page is written', () => {
  const s = setup();
  const entriesDir = join(s.root, 'web', 'plugin-entries');
  writeFileSync(join(s.root, 'secret.ts'), '');
  writeFileSync(join(s.root, 'outside.html'), '<p>x</p>');
  s.plugin(join(s.officialDir, 'esc'), { id: 'esc', webEntries: { a: '../../outside.html', b: 'b.html', c: 'c.html', d: 'd.html' } }, ['ok.ts']);
  writeFileSync(join(s.officialDir, 'esc', 'b.html'), '<script type="module" src="../../secret.ts"></script>');
  writeFileSync(join(s.officialDir, 'esc', 'c.html'), '<script type="module" src="./missing.ts"></script>');
  symlinkSync(join(s.root, 'secret.ts'), join(s.officialDir, 'esc', 'link.ts'));
  writeFileSync(join(s.officialDir, 'esc', 'd.html'), '<script type="module" src="./ok.ts"></script><script type="module" src="./link.ts"></script>');
  const r = generateWebModule({ ...s, entriesDir, log: () => {} });
  assert.deepEqual(r.entries, []);
  assert.equal(r.errors.length, 4);
  assert.ok(r.errors.every((e) => e.startsWith('plugin esc: webEntries')));
  assert.match(r.errors.join('\n'), /outside the plugin folder/);
  assert.ok(!existsSync(join(entriesDir, 'b.html')) && !existsSync(join(entriesDir, 'd.html')));
});
