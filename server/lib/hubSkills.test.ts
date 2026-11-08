import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildHubSkills, isSkillLink } from './hubSkills.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wh-hubskills-'));
  const skill = (plugin: string, name: string) => {
    mkdirSync(join(root, plugin, 'skills', name), { recursive: true });
    writeFileSync(join(root, plugin, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  };
  skill('a', 'one');
  skill('a', 'shared');
  skill('b', 'shared');
  skill('b', 'two');
  mkdirSync(join(root, 'b', 'skills', 'not-a-skill')); // no SKILL.md
  return root;
}

test('links the active plugins’ skills into one work-hub plugin, first plugin winning a name', () => {
  const root = fixture();
  try {
    const out = join(root, 'out');
    const r = buildHubSkills(out, [
      { id: 'a', dir: join(root, 'a'), skills: 'skills' },
      { id: 'b', dir: join(root, 'b'), skills: 'skills' },
      { id: 'c', dir: join(root, 'c') },
    ]);
    assert.deepEqual(r.skills, { one: 'a', shared: 'a', two: 'b' });
    assert.match(r.warnings.join('\n'), /"shared" is already provided by a/);
    assert.equal(JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'work-hub');
    assert.deepEqual(readdirSync(join(out, 'skills')).sort(), ['one', 'shared', 'two']);
    assert.ok(isSkillLink(join(out, 'skills', 'two')));
    assert.equal(realpathSync(join(out, 'skills', 'two')), realpathSync(join(root, 'b', 'skills', 'two')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rebuild drops the skills of plugins that are no longer active', () => {
  const root = fixture();
  try {
    const out = join(root, 'out');
    buildHubSkills(out, [{ id: 'b', dir: join(root, 'b'), skills: 'skills' }]);
    buildHubSkills(out, [{ id: 'a', dir: join(root, 'a'), skills: 'skills' }]);
    assert.deepEqual(readdirSync(join(out, 'skills')).sort(), ['one', 'shared']);
    buildHubSkills(out, []);
    assert.deepEqual(readdirSync(join(out, 'skills')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing skills folder is a warning, not a failure', () => {
  const root = fixture();
  try {
    const r = buildHubSkills(join(root, 'out'), [{ id: 'x', dir: join(root, 'x'), skills: 'nope' }]);
    assert.deepEqual(r.skills, {});
    assert.match(r.warnings[0], /\[plugin x\] skills folder nope doesn't exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
