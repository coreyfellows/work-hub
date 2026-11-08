import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addUpdateNote, applyAddendum, applyEdits, applyRewrite, demoteHeadings, findSection, joinSections, splitSections } from './doc.ts';

const DOC = `# Add caching

Adds a cache.

## Overview

The idea.

## How it works

### The \`Cache\` type

Holds things.

\`\`\`ts
# not a heading
## nor this
\`\`\`

### Wiring

Hooks it up.

## Minutiae

- CSS
`;

test('sections split on headings 1–3, ignoring fenced code, with stable slug ids', () => {
  const s = splitSections(DOC);
  assert.deepEqual(
    s.map((x) => [x.id, x.level, x.title]),
    [
      ['add-caching', 1, 'Add caching'],
      ['overview', 2, 'Overview'],
      ['how-it-works', 2, 'How it works'],
      ['the-cache-type', 3, 'The `Cache` type'],
      ['wiring', 3, 'Wiring'],
      ['minutiae', 2, 'Minutiae'],
    ],
  );
  assert.match(s[3].text, /## nor this/);
});

test('text before the first heading is the top section; repeated titles get -2', () => {
  const s = splitSections('intro\n\n## A\n\nx\n\n## A\n\ny\n');
  assert.deepEqual(s.map((x) => x.id), ['top', 'a', 'a-2']);
});

test('split then join keeps the content', () => {
  assert.equal(joinSections(splitSections(DOC)).replace(/\n+/g, '\n'), DOC.replace(/\n+/g, '\n'));
});

test('an addendum lands at the end of its section only, with its headings demoted', () => {
  const out = applyAddendum(DOC, 'wiring', '## Why\n\nBecause.', 'why is it wired here?');
  const s = splitSections(out);
  assert.equal(s.length, 6, 'no new section');
  const w = s.find((x) => x.id === 'wiring')!;
  assert.match(w.text, /Hooks it up\.\n\n\*\*Addendum\*\* \(asked: “why is it wired here\?”\)\n\n#### Why\n\nBecause\./);
  assert.doesNotMatch(s.find((x) => x.id === 'minutiae')!.text, /Addendum/);
});

test('a rewrite replaces the body, keeps the heading, and drops a repeated heading', () => {
  const out = applyRewrite(DOC, 'overview', '## Overview\n\nThe better idea.');
  const o = splitSections(out).find((x) => x.id === 'overview')!;
  assert.equal(o.text.trim(), '## Overview\n\nThe better idea.');
  assert.match(out, /## How it works/);
});

test('an unknown section throws', () => {
  assert.throws(() => applyRewrite(DOC, 'nope', 'x'), /no longer in the summary/);
});

test('demoting leaves code alone', () => {
  assert.equal(demoteHeadings('# A\n```\n# b\n```\n### C'), '#### A\n```\n# b\n```\n#### C');
});

test('a thread finds its section by id, else by title after a regeneration', () => {
  const s = splitSections('## Intro\n\nx\n\n## Wiring\n\ny\n');
  assert.equal(findSection(s, { sectionId: 'wiring', sectionTitle: 'Wiring' })?.id, 'wiring');
  assert.equal(findSection(splitSections('## Wiring\n\ny\n## Wiring\n'), { sectionId: 'old-id', sectionTitle: 'Wiring' })?.id, 'wiring');
  assert.equal(findSection(s, { sectionId: 'gone', sectionTitle: 'Gone' }), null);
});

test('update edits: replace, insert after (in order), remove; unknown ids are skipped', () => {
  const { markdown, skipped } = applyEdits(DOC, [
    { action: 'replace', section: 'overview', content: 'The new idea.' },
    { action: 'insert', after: 'wiring', content: '### Eviction\n\nOld entries go.\n\n## Not a section\n' },
    { action: 'insert', after: 'wiring', content: '### Metrics\n\nCounted.' },
    { action: 'remove', section: 'the-cache-type' },
    { action: 'remove', section: 'minutiae' },
    { action: 'replace', section: 'nope', content: 'x' },
  ]);
  const s = splitSections(markdown);
  assert.deepEqual(s.map((x) => x.id), ['add-caching', 'overview', 'how-it-works', 'wiring', 'eviction', 'metrics', 'minutiae']);
  assert.match(s[1].text, /## Overview\n\nThe new idea\./);
  assert.match(s[4].text, /#### Not a section/);
  assert.deepEqual(skipped, ['minutiae', 'nope']);
});

test('an insert without a heading is appended to the section it follows', () => {
  const { markdown } = applyEdits(DOC, [{ action: 'insert', after: 'wiring', content: 'Also logs.' }]);
  assert.match(splitSections(markdown).find((x) => x.id === 'wiring')!.text, /Hooks it up\.\n\nAlso logs\./);
});

test('update notes go in an Updates section before Minutiae, appended after the first', () => {
  const once = addUpdateNote(DOC, 'first');
  const twice = addUpdateNote(once, 'second\nline');
  const ids = splitSections(twice).map((x) => x.id);
  assert.deepEqual(ids.slice(-2), ['updates', 'minutiae']);
  assert.match(twice, /## Updates\n\n- first\n- second line\n\n## Minutiae/);
});
