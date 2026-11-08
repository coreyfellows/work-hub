import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryEntry, HistoryHost } from '../../plugin-api/server.ts';
import { HOST_MARK, hostEnricher } from './hostEnricher.ts';

function feed(records: unknown[], entriesBefore = 0): HistoryHost | null {
  const e = hostEnricher('host');
  const state = e.init!('s');
  const entries = Array.from({ length: entriesBefore }, (_, i) => ({ i, at: null, kind: 'user' }) as HistoryEntry);
  for (const rec of records) e.onRecord!(rec, { entries, push: (x) => void entries.push(x), state, at: null });
  return state.host;
}

test('HOST_MARK matches the greeting and the /fun host reply, nothing else', () => {
  assert.equal(HOST_MARK.exec('🦊  Fox has moved into your terminal.')?.[1], 'Fox');
  assert.equal(HOST_MARK.exec('<local-command-stdout>menagerie: 📺 Ron Burgundy has taken over.')?.[1], 'Ron Burgundy');
  // The bundled mod is named work-hub-menagerie, and Claude prefixes a command's output with the plugin's name.
  assert.equal(HOST_MARK.exec('<local-command-stdout>work-hub-menagerie: 🗼 Zed has taken over.')?.[1], 'Zed');
  assert.equal(HOST_MARK.exec('Fox has moved into your terminal.'), null);
  assert.equal(HOST_MARK.exec('🦊 Fox has left the terminal.'), null);
});

test('the greeting (system), a swap (user string) and a user message content all count; the latest wins', () => {
  assert.deepEqual(feed([{ type: 'system', content: '🦊 Fox has moved into your terminal.' }]), { name: 'Fox', at: 0 });
  assert.deepEqual(
    feed(
      [
        { type: 'system', content: '🦊 Fox has moved into your terminal.' },
        { type: 'user', message: { content: '<local-command-stdout>menagerie: 🎳 The Dude has taken over.</local-command-stdout>' } },
      ],
      3,
    ),
    { name: 'The Dude', at: 3 },
  );
});

test('sidechains and other records are ignored; it never consumes a record', () => {
  assert.equal(feed([{ type: 'system', isSidechain: true, content: '🦊 Fox has moved into your terminal.' }]), null);
  assert.equal(feed([{ type: 'assistant', content: '🦊 Fox has moved into your terminal.' }, null, 'x']), null);
  const e = hostEnricher('host');
  const r = e.onRecord!({ type: 'system', content: '🦊 Fox has moved into your terminal.' }, { entries: [], push: () => {}, state: e.init!('s'), at: null });
  assert.equal(r, undefined);
});
