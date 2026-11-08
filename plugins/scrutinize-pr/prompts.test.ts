import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askPrompt, inlineDiff, parseAnswer, parseUpdate, summaryPrompt, updatePrompt, type PrFacts } from './prompts.ts';

const pr: PrFacts = {
  repo: 'o/r',
  number: 7,
  url: 'https://gh/o/r/pull/7',
  title: 'Add caching',
  body: 'Makes it fast.',
  author: 'alice',
  base: 'main',
  head: 'cache',
  headOid: 'h'.repeat(40),
  mergeBase: 'b'.repeat(40),
  blobBase: 'https://gh/o/r/blob/hhh/',
  files: [{ path: 'a.ts', status: 'modified', additions: 3, deletions: 1 }],
};

test('the summary prompt asks for the narrative outline with Minutiae last, links and snippets', () => {
  const p = summaryPrompt(pr, { mode: 'git' });
  const order = ['# Add caching', '## Overview', '## How it works', '## Behaviour changes and risks', '## Tests', '## Minutiae'].map((h) => p.indexOf(`\n${h}\n`));
  assert.ok(order.every((i) => i > 0), 'every heading is in the outline');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
  assert.match(p, /https:\/\/gh\/o\/r\/blob\/hhh\/path\/to\/file\.ts#L42/);
  assert.match(p, new RegExp(`git diff ${'b'.repeat(40)}\\.\\.${'h'.repeat(40)}`));
  assert.match(p, /never read files from disk/);
  assert.doesNotMatch(p, /<diff>/);
});

test('inline mode carries the diff and says there are no tools', () => {
  const p = summaryPrompt(pr, { mode: 'inline', diff: 'diff --git a/a.ts b/a.ts\n+x' });
  assert.match(p, /You have no tools/);
  assert.match(p, /<diff>\ndiff --git a\/a\.ts b\/a\.ts\n\+x\n<\/diff>$/);
});

test('the ask prompt has the section, the selected passage, the thread and the question', () => {
  const p = askPrompt(pr, { mode: 'git' }, {
    summary: '# S',
    sectionTitle: 'Wiring',
    sectionText: '### Wiring\n\nHooks.',
    quote: 'Hooks.',
    history: [{ role: 'you', text: 'first?' }, { role: 'claude', text: 'answer' }],
    question: 'and then?',
  });
  assert.match(p, /section "Wiring"/);
  assert.match(p, /<selected>\nHooks\.\n<\/selected>/);
  assert.match(p, /Reader: first\?\nYou: answer/);
  assert.match(p, /<question>\nand then\?\n<\/question>/);
  assert.match(p, /"kind": "reply" \| "addendum" \| "rewrite"/);
});

test('answers parse with or without a fence, and degrade sensibly', () => {
  assert.deepEqual(parseAnswer('{"kind":"reply","reply":"yes","content":""}'), { kind: 'reply', reply: 'yes', content: '' });
  assert.deepEqual(parseAnswer('```json\n{"kind":"addendum","reply":"","content":"More."}\n```'), { kind: 'addendum', reply: 'Added an addendum to this section.', content: 'More.' });
  assert.equal(parseAnswer('Sure: {"kind":"rewrite","reply":"r","content":"c"} done').kind, 'rewrite');
  // An addendum without content is just a reply; an unknown kind is a reply.
  assert.deepEqual(parseAnswer('{"kind":"addendum","reply":"r"}'), { kind: 'reply', reply: 'r', content: '' });
  assert.equal(parseAnswer('{"kind":"weird","reply":"r"}').kind, 'reply');
  assert.throws(() => parseAnswer('no json here'), /not JSON/);
  assert.throws(() => parseAnswer('{"kind":"reply"}'), /empty/);
});

test('the inline diff is capped', () => {
  const d = inlineDiff([{ path: 'a', patch: 'x'.repeat(50) }, { path: 'b', patch: 'y'.repeat(50) }], 80);
  assert.match(d, /diff --git a\/a b\/a/);
  assert.doesNotMatch(d, /b\/b/);
  assert.match(d, /truncated at 80/);
  assert.match(inlineDiff([{ path: 'img.png', patch: null }]), /binary or too large/);
});

test('the update prompt scopes the work to what changed and lists the section ids', () => {
  const p = updatePrompt(pr, { mode: 'git' }, {
    summary: '# S\n\n## Overview\n',
    sections: [{ id: 's', title: 'S' }, { id: 'overview', title: 'Overview' }],
    oldHead: 'o'.repeat(40),
    oldMergeBase: 'm'.repeat(40),
    oldAvailable: true,
    newFiles: ['new.ts'],
    changedFiles: ['a.ts'],
    goneFiles: [],
  });
  assert.match(p, /an update, not a rewrite/);
  assert.match(p, new RegExp(`git diff ${'o'.repeat(40)} ${'h'.repeat(40)} -- <path>`));
  assert.match(p, /- new in the PR: new\.ts\n- changed: a\.ts/);
  assert.match(p, /- `overview`: Overview/);
  const gone = updatePrompt(pr, { mode: 'git' }, { summary: '', sections: [], oldHead: 'o'.repeat(40), oldMergeBase: null, oldAvailable: false, newFiles: [], changedFiles: [], goneFiles: [] });
  assert.match(gone, /no longer available/);
});

test('update answers keep only well-formed edits', () => {
  const u = parseUpdate('```json\n{"note":"Added eviction.","edits":[{"action":"replace","section":"a","content":"x"},{"action":"insert","after":"a","content":"### B"},{"action":"remove","section":"c"},{"action":"replace","section":"d"},{"action":"bogus"}]}\n```');
  assert.equal(u.note, 'Added eviction.');
  assert.deepEqual(u.edits.map((e) => e.action), ['replace', 'insert', 'remove']);
  assert.match(parseUpdate('{"edits":[]}').note, /change nothing/);
  assert.throws(() => parseUpdate('nope'), /not JSON/);
});
