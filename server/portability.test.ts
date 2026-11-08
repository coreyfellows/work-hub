import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Nothing owner-specific may live in the repo. What counts as owner-specific (names, hostnames, employers, internal
// services) is itself private, so the patterns live outside the repo: one regular expression per line (case-insensitive,
// `#` starts a comment) in $WORK_HUB_PORTABILITY_PATTERNS, else <config dir>/portability-patterns.txt (the config dir is
// $WORK_HUB_CONFIG_DIR, else ${XDG_CONFIG_HOME:-~/.config}/work-hub). With neither, the repo scan is skipped. Lines may
// opt out with a `portability-ok` comment.
export interface Hit { file: string; line: number; match: string }

export function patternsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORK_HUB_PORTABILITY_PATTERNS) return env.WORK_HUB_PORTABILITY_PATTERNS;
  const configDir = env.WORK_HUB_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'work-hub');
  return join(configDir, 'portability-patterns.txt');
}

export function parsePatterns(text: string): RegExp[] {
  return text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .map((l) => new RegExp(l, 'i'));
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.superpowers']);
// LICENSE names the copyright holder, which is meant to be public.
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'web/src/plugins.generated.ts', 'LICENSE']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|pdf|zip|gz|db|sqlite|wasm|mp3|mp4|mov)$/i;

export function scanTree(root: string, patterns: RegExp[]): Hit[] {
  const hits: Hit[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      const st = statSync(full);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
        continue;
      }
      if (!st.isFile() || name === '.git' || SKIP_FILES.has(rel) || BINARY_EXT.test(name)) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue;
      buf.toString('utf8').split('\n').forEach((text, i) => {
        if (text.includes('portability-ok')) return;
        for (const re of patterns) {
          const m = re.exec(text);
          if (m) { hits.push({ file: rel, line: i + 1, match: m[0] }); break; }
        }
      });
    }
  };
  walk(root);
  return hits;
}

test('scanTree finds owner strings, honours opt-outs and skips', () => {
  const d = mkdtempSync(join(tmpdir(), 'portability-'));
  mkdirSync(join(d, 'node_modules'));
  writeFileSync(join(d, 'a.ts'), 'ok\nhome is /Users/OWNER-NAME/x\n');
  writeFileSync(join(d, 'b.md'), 'laptop-7 # portability-ok\nclean\n');
  writeFileSync(join(d, 'node_modules', 'c.js'), 'owner-name');
  mkdirSync(join(d, '.superpowers'));
  writeFileSync(join(d, '.superpowers', 'h.md'), 'owner-name');
  writeFileSync(join(d, 'bin.dat'), Buffer.from([0, ...Buffer.from('owner-name')]));
  assert.deepEqual(scanTree(d, parsePatterns('# owner\nowner-name\nlaptop-\\d+  # a host\n')), [{ file: 'a.ts', line: 2, match: 'OWNER-NAME' }]);
});

test('patternsFile: the env var wins, then the config dir', () => {
  assert.equal(patternsFile({ WORK_HUB_PORTABILITY_PATTERNS: '/p.txt' }), '/p.txt');
  assert.equal(patternsFile({ WORK_HUB_CONFIG_DIR: '/cfg' }), join('/cfg', 'portability-patterns.txt'));
  assert.equal(patternsFile({ XDG_CONFIG_HOME: '/x' }), join('/x', 'work-hub', 'portability-patterns.txt'));
});

const file = patternsFile();
test('the repo has no owner-specific strings', { skip: existsSync(file) ? false : `no patterns file at ${file}` }, () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const hits = scanTree(root, parsePatterns(readFileSync(file, 'utf8')));
  assert.equal(hits.length, 0, '\n' + hits.map((h) => `${h.file}:${h.line}: ${h.match}`).join('\n'));
});
