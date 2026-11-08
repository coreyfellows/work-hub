import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, slashCommands } from './commands.ts';

test('parseFrontmatter: plain, quoted, block scalar, not invocable', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: "Do a thing"\n---\nbody'), { name: 'a', description: 'Do a thing', invocable: true });
  assert.equal(parseFrontmatter('---\ndescription: >\n  one\n  two\n---\n').description, 'one two');
  assert.equal(parseFrontmatter('---\nuser-invocable: false\n---\n').invocable, false);
  assert.deepEqual(parseFrontmatter('no front matter'), { invocable: true });
});

test('slashCommands gathers project, user and enabled plugin commands, plus built-ins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sc-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'sc-cwd-'));
  await mkdir(join(home, '.claude', 'skills', 'wrangler'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'wrangler', 'SKILL.md'), '---\nname: wrangler\ndescription: Cloudflare CLI\n---\n');
  await mkdir(join(cwd, '.claude', 'commands', 'sub'), { recursive: true });
  await writeFile(join(cwd, '.claude', 'commands', 'sub', 'ship.md'), '---\ndescription: Ship it\n---\nx');
  const plug = join(home, '.claude', 'plugins', 'cache', 'p');
  await mkdir(join(plug, 'skills', 'hello'), { recursive: true });
  await mkdir(join(plug, 'skills', 'off'), { recursive: true });
  await writeFile(join(plug, 'skills', 'hello', 'SKILL.md'), '---\ndescription: Say hi\n---\n');
  await writeFile(join(plug, 'skills', 'off', 'SKILL.md'), '---\nuser-invocable: false\n---\n');
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
  await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'greet@m': [{ scope: 'user', installPath: plug }], 'dis@m': [{ scope: 'user', installPath: plug }] } }));
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'greet@m': true, 'dis@m': false } }));
  const cmds = await slashCommands(cwd, home);
  const names = cmds.map((c) => c.name);
  assert.ok(names.includes('wrangler') && names.includes('sub:ship') && names.includes('greet:hello') && names.includes('compact'));
  assert.ok(!names.includes('greet:off') && !names.some((n) => n.startsWith('dis:')));
  assert.equal(cmds.find((c) => c.name === 'sub:ship')?.source, 'project');
  assert.equal(cmds.find((c) => c.name === 'greet:hello')?.description, 'Say hi');
});
