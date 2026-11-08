import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorPrompt, branchSlug, resolveDestination, validateCreate, type AuthorPromptOpts, type CreateInput, type PathKind } from './create.ts';

const REPO = '/home/u/repos/work-hub';
const opts = (over: Partial<Parameters<typeof validateCreate>[1]> = {}) => ({
  taken: new Set(['github', 'old-github', 'health']),
  officialAvailable: true,
  repoRoot: REPO,
  ...over,
});
const err = (r: ReturnType<typeof validateCreate>) => (r.ok ? null : r.error);

test('validateCreate: shape errors', () => {
  assert.match(err(validateCreate(null, opts()))!, /JSON object/);
  assert.match(err(validateCreate([], opts()))!, /JSON object/);
  assert.match(err(validateCreate({ official: true, description: '   ' }, opts()))!, /what the plugin should do/i);
  assert.match(err(validateCreate({ official: true }, opts()))!, /what the plugin should do/i);
  assert.match(err(validateCreate({ official: 'true', description: 'x' }, opts()))!, /official: expected true or false/);
  assert.match(err(validateCreate({ official: true, defaultEnabled: 'yes', description: 'x' }, opts()))!, /defaultEnabled: expected true or false/);
  assert.match(err(validateCreate({ official: true, name: 7, description: 'x' }, opts()))!, /name: expected a string/);
});

test('validateCreate: name rule', () => {
  for (const bad of ['Standup', '1st', '-x', 'a_b', 'a b', 'ä']) {
    assert.match(err(validateCreate({ official: true, name: bad, description: 'x' }, opts()))!, /lowercase letters, digits and dashes/, bad);
  }
  const r = validateCreate({ official: true, name: '  standup-2 ', description: 'x' }, opts());
  assert.equal(r.ok && r.input.name, 'standup-2');
  const blank = validateCreate({ official: true, name: '  ', description: 'x' }, opts());
  assert.equal(blank.ok && blank.input.name, null);
});

test('validateCreate: alias and built-in ids are taken, and core is reserved', () => {
  for (const id of ['github', 'old-github', 'health', 'core']) {
    assert.match(err(validateCreate({ official: true, name: id, description: 'x' }, opts()))!, /already|reserved/, id);
  }
});

test('validateCreate: official needs a git checkout', () => {
  assert.match(err(validateCreate({ official: true, description: 'x' }, opts({ officialAvailable: false })))!, /git checkout/);
});

test('validateCreate: local needs an absolute destination', () => {
  assert.match(err(validateCreate({ official: false, description: 'x' }, opts()))!, /where to put/i);
  assert.match(err(validateCreate({ official: false, destination: '  ', description: 'x' }, opts()))!, /where to put/i);
  assert.match(err(validateCreate({ official: false, destination: '~/plugins', description: 'x' }, opts()))!, /absolute path/);
  assert.match(err(validateCreate({ official: false, destination: 'plugins/x', description: 'x' }, opts()))!, /absolute path/);
  assert.match(err(validateCreate({ official: false, destination: 3, description: 'x' }, opts()))!, /where to put/i);
});

test('validateCreate: destination inside the repo', () => {
  for (const d of [REPO, `${REPO}/`, `${REPO}/plugins/mine`, `${REPO}/../work-hub/x`]) {
    assert.match(err(validateCreate({ official: false, destination: d, description: 'x' }, opts()))!, /inside work-hub/, d);
  }
  // A sibling whose name starts the same is outside.
  assert.equal(validateCreate({ official: false, destination: `${REPO}-plugins`, description: 'x' }, opts()).ok, true);
});

test('validateCreate: ok official / ok local', () => {
  const o = validateCreate({ official: true, defaultEnabled: false, destination: '/ignored', description: '  Show standup  ' }, opts());
  assert.deepEqual(o, { ok: true, input: { name: null, official: true, defaultEnabled: false, destination: null, description: 'Show standup' } });
  const o2 = validateCreate({ official: true, description: 'x' }, opts());
  assert.equal(o2.ok && o2.input.defaultEnabled, true);
  // Local plugins are always on by default (the spec); the destination is normalized.
  const l = validateCreate({ official: false, defaultEnabled: false, name: 'mine', destination: '/home/u/my-plugins/', description: 'x' }, opts());
  assert.deepEqual(l, { ok: true, input: { name: 'mine', official: false, defaultEnabled: true, destination: '/home/u/my-plugins', description: 'x' } });
});

const fsOf =
  (m: Record<string, PathKind>) =>
  (p: string): PathKind =>
    m[p] ?? 'missing';

test('resolveDestination: listed folder with and without a name', () => {
  const folders = ['/p/plugins'];
  const kind = fsOf({ '/p/plugins': 'dir' });
  assert.deepEqual(resolveDestination({ destination: '/p/plugins', name: 'standup' }, { folders, kind }), {
    ok: true,
    dest: { addDir: '/p/plugins', pluginDir: '/p/plugins/standup', folder: '/p/plugins', create: '/p/plugins' },
  });
  assert.deepEqual(resolveDestination({ destination: '/p/plugins', name: null }, { folders, kind }), {
    ok: true,
    dest: { addDir: '/p/plugins', pluginDir: null, folder: '/p/plugins', create: '/p/plugins' },
  });
  // A listed folder written with a trailing slash still matches.
  const r = resolveDestination({ destination: '/p/plugins', name: 'x' }, { folders: ['/p/plugins/'], kind });
  assert.equal(r.ok && r.dest.folder, '/p/plugins');
  // An empty child folder is fine.
  const e = resolveDestination({ destination: '/p/plugins', name: 'x' }, { folders, kind: fsOf({ '/p/plugins': 'dir', '/p/plugins/x': 'empty-dir' }) });
  assert.equal(e.ok, true);
});

test('resolveDestination: listed folder, child taken', () => {
  const r = resolveDestination({ destination: '/p/plugins', name: 'x' }, { folders: ['/p/plugins'], kind: fsOf({ '/p/plugins': 'dir', '/p/plugins/x': 'dir' }) });
  assert.match(r.ok ? '' : r.error, /\/p\/plugins\/x already exists and isn't empty/);
  const f = resolveDestination({ destination: '/p/plugins', name: 'x' }, { folders: ['/p/plugins'], kind: fsOf({ '/p/plugins': 'dir', '/p/plugins/x': 'file' }) });
  assert.match(f.ok ? '' : f.error, /already exists/);
});

test('resolveDestination: new path / empty dir is the plugin folder', () => {
  for (const kind of [fsOf({}), fsOf({ '/q/standup': 'empty-dir' })]) {
    assert.deepEqual(resolveDestination({ destination: '/q/standup', name: 'whatever' }, { folders: ['/p/plugins'], kind }), {
      ok: true,
      dest: { addDir: '/q/standup', pluginDir: '/q/standup', folder: null, create: '/q/standup' },
    });
  }
});

test('resolveDestination: unlisted non-empty folder', () => {
  const r = resolveDestination({ destination: '/q/stuff', name: null }, { folders: [], kind: fsOf({ '/q/stuff': 'dir' }) });
  assert.match(r.ok ? '' : r.error, /already exists and isn't empty/);
  assert.match(r.ok ? '' : r.error, /Settings → Plugins/); // says how to use it as a folder of plugins
});

test('resolveDestination: a file', () => {
  const r = resolveDestination({ destination: '/q/file', name: null }, { folders: [], kind: fsOf({ '/q/file': 'file' }) });
  assert.match(r.ok ? '' : r.error, /not a folder/);
});

test('branchSlug', () => {
  assert.equal(branchSlug('standup', 'anything', 'ab12'), 'standup');
  assert.equal(branchSlug(null, 'Show my Standup from yesterday, please', 'ab12'), 'show-my-standup-from-ab12');
  assert.equal(branchSlug(null, '!!! ???', 'ab12'), 'new-ab12');
  assert.equal(branchSlug(null, 'Supercalifragilisticexpialidocious-and-more-words-here', 'ab12'), 'supercalifragilisticexpi-ab12');
  assert.ok(!branchSlug(null, 'Über Ärger', 'ab12').includes('--'));
});

const base = (over: Omit<Partial<AuthorPromptOpts>, 'input'> & { input?: Partial<CreateInput> } = {}): AuthorPromptOpts => ({
  workspaceId: 'ws-1',
  worktree: '/w/work-hub/plugin-standup',
  branch: 'plugin-standup',
  base: 'origin/main',
  appRepo: '/r/work-hub',
  configFile: '/c/plugins.json',
  whCommand: '/r/work-hub/bin/wh',
  rules: ['RULE ONE', 'RULE TWO'],
  dest: null,
  ...over,
  input: { name: 'standup', official: true, defaultEnabled: false, destination: null, description: 'Show what I did yesterday.\nWith links.', ...over.input },
});

test('authorPrompt: official', () => {
  const p = authorPrompt(base());
  assert.ok(p.includes('Show what I did yesterday.\nWith links.'));
  assert.match(p, /id is `standup`/);
  assert.match(p, /official/i);
  assert.ok(p.includes('/w/work-hub/plugin-standup/plugins/standup/'));
  assert.match(p, /"defaultEnabled": false/);
  for (const f of ['CLAUDE.md', 'docs/plugins.md', 'plugin-api/', 'CHANGELOG.md']) assert.ok(p.includes(f), f);
  assert.match(p, /README\.md/);
  assert.match(p, /Official plugins table/);
  assert.match(p, /pnpm typecheck/);
  assert.match(p, /pnpm test/);
  assert.ok(p.includes('/r/work-hub'));
  assert.match(p, /scripts\/update\.sh --no-pull/);
  assert.match(p, /AskUserQuestion/);
  assert.ok(p.includes('/r/work-hub/bin/wh note ws-1'));
  assert.ok(!p.includes('check-plugin'));
});

test('authorPrompt: local into folder, unnamed', () => {
  const p = authorPrompt(
    base({
      input: { name: null, official: false, defaultEnabled: true, destination: '/p/plugins' },
      dest: { addDir: '/p/plugins', pluginDir: null, folder: '/p/plugins', create: '/p/plugins' },
    }),
  );
  assert.match(p, /local/i);
  assert.match(p, /pick a short kebab-case id/i);
  assert.match(p, /GET \/api\/plugins/);
  assert.ok(p.includes('/p/plugins/<id>/'));
  assert.match(p, /"defaultEnabled": true/);
  assert.ok(p.includes('/c/plugins.json'));
  assert.match(p, /enabled/);
  assert.match(p, /pnpm check-plugin/);
  assert.ok(!p.includes('Official plugins table'));
  // A local plugin in its own new folder: that folder goes in `local` itself.
  const own = authorPrompt(
    base({
      input: { name: 'mine', official: false, defaultEnabled: true, destination: '/q/mine' },
      dest: { addDir: '/q/mine', pluginDir: '/q/mine', folder: null, create: '/q/mine' },
    }),
  );
  assert.ok(own.includes('`/q/mine`'));
  assert.match(own, /add `\/q\/mine` to `local`/);
});

test('authorPrompt: API rules and workspace rules last', () => {
  const p = authorPrompt(base());
  assert.match(p, /additive/i);
  assert.match(p, /significant plugin-API change/);
  assert.match(p, /bump `apiVersion`/);
  assert.match(p, /migrate every official plugin/i);
  assert.match(p, /look basically the same/i);
  assert.ok(p.trimEnd().endsWith('RULE ONE\nRULE TWO'));
});
