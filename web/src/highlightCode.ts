import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import hcl from './hclLang.ts';
import 'highlight.js/styles/github-dark.css';

/**
 * Syntax highlighting for whole files shown in the log (a file a session created). Loaded lazily by EditCard
 * (`import('../highlightCode.ts')`) so highlight.js stays out of the main bundle.
 */

const LANGS = { hcl, bash, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, python, ruby, rust, scss, sql, swift, typescript, xml, yaml, cpp, csharp };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json', json5: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml',
  md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  sql: 'sql', diff: 'diff', patch: 'diff',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl', nomad: 'hcl', tftpl: 'hcl',
};

/** The highlight.js language for a path, by extension (or name, for Dockerfile), else by a shebang; null = plain text. */
export function languageFor(path: string, content: string): string | null {
  const name = path.split('/').pop() ?? '';
  if (/^dockerfile/i.test(name)) return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (BY_EXT[ext]) return BY_EXT[ext]!;
  const shebang = /^#!.*\b(bash|sh|zsh|python3?|node|ruby)\b/.exec(content);
  if (shebang) return { bash: 'bash', sh: 'bash', zsh: 'bash', python: 'python', python3: 'python', node: 'javascript', ruby: 'ruby' }[shebang[1]!] ?? null;
  return null;
}

/** Highlighted HTML (escaped by highlight.js), or null for plain text / unknown types. */
export function highlightFile(path: string, content: string): string | null {
  const lang = languageFor(path, content);
  if (!lang) return null;
  try {
    return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * `text` highlighted as one block (so multi-line strings/comments colour right), split back into one HTML string
 * per line with open spans closed at each line end and reopened on the next. null for plain text / unknown types.
 */
export function highlightLines(path: string, text: string): string[] | null {
  const html = highlightFile(path, text);
  if (html === null) return null;
  const out: string[] = [];
  const open: string[] = [];
  for (const raw of html.split('\n')) {
    let line = open.join('') + raw;
    for (const m of raw.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (m[0] === '</span>') open.pop();
      else open.push(m[0]);
    }
    line += '</span>'.repeat(open.length);
    out.push(line);
  }
  return out;
}

/**
 * Command output, highlighted: JSON when it all parses as JSON, a diff when it looks like one, else the best
 * highlight.js guess among formats commands commonly print, kept only if it's a confident one. Returns the
 * language too (null = shown plain).
 */
export function highlightOutput(text: string): { html: string; language: string | null } | null {
  const t = text.trim();
  let lang: string | null = null;
  try {
    if (/^[[{]/.test(t)) {
      JSON.parse(t);
      lang = 'json';
    }
  } catch {
    /* not JSON */
  }
  if (!lang && /^(diff --git|--- |\+\+\+ |@@ )/m.test(t) && /^@@ /m.test(t)) lang = 'diff';
  try {
    if (lang) return { html: hljs.highlight(text, { language: lang, ignoreIllegals: true }).value, language: lang };
    const auto = hljs.highlightAuto(text, ['json', 'yaml', 'xml', 'ini', 'bash', 'diff', 'sql']);
    return auto.relevance >= 8 && auto.language ? { html: auto.value, language: auto.language } : null;
  } catch {
    return null;
  }
}
