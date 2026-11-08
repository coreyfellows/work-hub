import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asideInstruction, funReply, greeting, parseCast, pickHost, tookOver, type ModHost } from './claude/hooks/logic.ts';
import { HOST_MARK } from './hostEnricher.ts';

const host = (id: string, over: Partial<ModHost> = {}): ModHost => ({
  id,
  name: `Host ${id}`,
  emoji: '🗼',
  voice: 'Talks like a lighthouse.',
  spinner: ['Polishing'],
  ...over,
});

test('greeting and tookOver match the work-hub side\'s HOST_MARK', () => {
  const h = host('zed', { name: 'Zed the Keeper' });
  assert.equal(greeting(h), '🗼  Zed the Keeper has moved into your terminal.');
  assert.equal(tookOver(h), '🗼 Zed the Keeper has taken over.');
  assert.equal(HOST_MARK.exec(greeting(h))?.[1], 'Zed the Keeper');
  assert.equal(HOST_MARK.exec(`<local-command-stdout>menagerie: ${tookOver(h)}`)?.[1], 'Zed the Keeper');
});

test('asideInstruction keeps the exact aside format and title', () => {
  const text = asideInstruction(host('zed'));
  assert.ok(text.includes('# The resident character'));
  assert.ok(text.includes('`> 🗼 *the aside*`'));
  assert.ok(text.includes('roughly one in three'));
  assert.ok(text.includes('Talks like a lighthouse.'));
  assert.ok(text.includes('subagent'));
});

test('parseCast: lenient, keeps only hosts with the fields the mod needs', () => {
  assert.deepEqual(parseCast('{'), []);
  assert.deepEqual(parseCast('{"characters": 3}'), []);
  const text = JSON.stringify({ characters: [{ ...host('a'), portrait: {} }, { id: 'b', name: 'B' }, { ...host('c', { emoji: '🎺' }), rare: true }] });
  const hosts = parseCast(text);
  assert.deepEqual(hosts.map((h) => h.id), ['a', 'c']);
  assert.equal(hosts[1].rare, true);
  assert.equal((hosts[0] as unknown as { portrait?: unknown }).portrait, undefined);
});

test('pickHost: none, avoids the last host, rare only now and then', () => {
  const a = host('a');
  const b = host('b');
  const moth = host('moth', { rare: true });
  assert.equal(pickHost([], null, () => 0), null);
  assert.equal(pickHost([a, b, moth], 'a', () => 0.99)?.id, 'b');
  assert.equal(pickHost([a, b, moth], 'a', () => 0.5)?.id, 'b');
  // 1 in 20: the first draw under 0.05 picks among the rare ones.
  assert.equal(pickHost([a, b, moth], 'a', () => 0.01)?.id, 'moth');
  assert.equal(pickHost([a], 'a', () => 0.5)?.id, 'a');
  assert.equal(pickHost([moth], null, () => 0.9)?.id, 'moth');
});

test('funReply: host swap, the list, on and off', () => {
  const a = host('a');
  const b = host('b', { emoji: '🎺' });
  const swap = funReply('host b', [a, b]);
  assert.equal(swap.host?.id, 'b');
  assert.equal(swap.text, tookOver(b));
  const gone = funReply('host removed', [a, b]);
  assert.equal(gone.host, undefined);
  assert.match(gone.text, /🗼 a.*🎺 b/);
  assert.match(funReply('', [a, b]).text, /🎺 b/);
  assert.equal(funReply('off', [a]).off, true);
  assert.equal(funReply('on', [a]).on, true);
});

test('parseCast applies the validator\'s basic rules: id pattern, name and voice caps, unique id and emoji (review I5)', () => {
  const text = JSON.stringify({
    characters: [
      host('a'),
      host('Bad Id!'),
      host('long', { emoji: '🐙', voice: 'x'.repeat(601) }),
      host('a', { emoji: '🎺' }),
      host('b'),
      host('c', { emoji: '🐳', name: 'n'.repeat(41) }),
      host('d', { emoji: '🦄' }),
    ],
  });
  assert.deepEqual(parseCast(text).map((h) => h.id), ['a', 'd']);
});
