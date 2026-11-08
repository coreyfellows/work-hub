import type { HLJSApi, Language } from 'highlight.js';

/**
 * HCL (Terraform `.tf`/`.tfvars`, Packer, Nomad `.hcl`) for highlight.js, which ships none: comments, block types and
 * their labels, attribute names, strings with `${…}` / `%{…}` interpolation, heredocs, numbers, literals and function calls.
 */
export default function hcl(hljs: HLJSApi): Language {
  const interp = { className: 'subst', begin: /[$%]\{/, end: /\}/, contains: [] as unknown[] };
  const string = { className: 'string', begin: /"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE, interp] };
  const heredoc = { className: 'string', begin: /<<-?\s*([A-Za-z_][\w-]*)\s*$/, end: /^\s*([A-Za-z_][\w-]*)\s*$/, contains: [interp] };
  const number = { className: 'number', begin: /\b\d+(\.\d+)?([eE][+-]?\d+)?\b/, relevance: 0 };
  const literal = { className: 'literal', begin: /\b(true|false|null)\b/ };
  const keyword = { className: 'keyword', begin: /\b(for|in|if|else|endif|endfor)\b/ };
  const call = { className: 'title.function', begin: /\b[a-z_][\w]*(?=\s*\()/, relevance: 0 };
  const reference = { className: 'variable', begin: /\b(var|local|module|data|each|count|path|terraform|self)\.[\w.-]*/ };
  const comments = [hljs.HASH_COMMENT_MODE, hljs.C_LINE_COMMENT_MODE, hljs.C_BLOCK_COMMENT_MODE];
  const expr = [...comments, string, heredoc, number, literal, keyword, reference, call];
  interp.contains = [string, number, literal, keyword, reference, call];
  return {
    name: 'HCL',
    aliases: ['terraform', 'tf'],
    contains: [
      ...comments,
      // A block: `resource "aws_s3_bucket" "logs" {`, `locals {`, `dynamic "rule" {`.
      {
        begin: [/^\s*/, /[A-Za-z_][\w-]*/, /(?=(\s+("[^"\n]*"|[A-Za-z_][\w-]*))*\s*\{)/],
        beginScope: { 2: 'keyword' },
        relevance: 5,
      },
      // An attribute: `name = …` (not `==` or a for expression's `=>`).
      { begin: [/[A-Za-z_][\w-]*/, /\s*(?==(?![=>]))/], beginScope: { 1: 'attr' }, relevance: 0 },
      ...expr.slice(comments.length),
    ],
  };
}
