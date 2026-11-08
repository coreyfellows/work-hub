import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToPlain } from './plainText.ts';

test('emphasis, headings, quotes, inline code lose their markup', () => {
  assert.equal(markdownToPlain('## Title\n\nSome **bold**, *it*, _it2_ and `code`.\n> quoted'), 'Title\n\nSome bold, it, it2 and code.\nquoted');
});

test('links keep their address unless the text is the address; images keep alt text', () => {
  assert.equal(markdownToPlain('[docs](https://x.dev/a) and [https://x.dev](https://x.dev) ![logo](l.png)'), 'docs (https://x.dev/a) and https://x.dev logo');
});

test('code fences are dropped but their content stays as typed', () => {
  assert.equal(markdownToPlain('Run:\n\n```sh\nls **/*.ts\n```\nDone'), 'Run:\n\nls **/*.ts\nDone');
});

test('lists keep a dash; snake_case and 2*3*4 are left alone', () => {
  assert.equal(markdownToPlain('* one\n+ two\n- three\nmy_var_name and 2*3*4'), '- one\n- two\n- three\nmy_var_name and 2*3*4');
});

test('tables become tab-separated rows without the divider', () => {
  assert.equal(markdownToPlain('| a | b |\n|---|---|\n| 1 | 2 |'), 'a\tb\n1\t2');
});
