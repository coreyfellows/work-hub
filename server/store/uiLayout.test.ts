import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLayout } from './uiLayout.ts';

test('keeps valid id lists, drops non-strings, odd ids and duplicates', () => {
  assert.deepEqual(cleanLayout({ tabs: ['note', 'details', 'note', 5, 'Bad Id!', ''], sections: ['links', 'links', 'activity'], views: ['log', 'chat'] }), {
    tabs: ['note', 'details'],
    sections: ['links', 'activity'],
    views: ['log', 'chat'],
    items: {},
  });
});

test('missing or wrong-typed lists become empty', () => {
  assert.deepEqual(cleanLayout({}), { tabs: [], sections: [], views: [], items: {} });
  assert.deepEqual(cleanLayout(null), { tabs: [], sections: [], views: [], items: {} });
  assert.deepEqual(cleanLayout({ tabs: 'details', sections: { a: 1 } }), { tabs: [], sections: [], views: [], items: {} });
});

test('caps each list at 20 entries', () => {
  const many = Array.from({ length: 50 }, (_, i) => `s${i}`);
  assert.equal(cleanLayout({ tabs: many, sections: many }).tabs.length, 20);
});

test('per-workspace item orders keep UUID-like ids, drop bad keys/ids/duplicates and empty lists', () => {
  const l = cleanLayout({
    items: {
      'work-hub': ['s-0f8e1c2a-1111-4222-8333-444455556666', 't-abc123', 't-abc123', 'bad id', 7],
      'bad key!': ['t-1'],
      empty: [],
      notalist: 'x',
    },
  });
  assert.deepEqual(l.items, { 'work-hub': ['s-0f8e1c2a-1111-4222-8333-444455556666', 't-abc123'] });
});
