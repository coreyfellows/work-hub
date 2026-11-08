import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createTranscriptWatcher } from './transcriptWatch.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wh-transcript-watch-'));
  dirs.push(dir);
  const p = join(dir, 'session.jsonl');
  await writeFile(p, '{"type":"user"}\n');
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves once `count()` reaches `n`, or rejects after `ms`. */
async function until(count: () => number, n: number, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (count() < n) {
    if (Date.now() > end) throw new Error(`expected ${n} notifications, got ${count()}`);
    await sleep(20);
  }
}

test('an append notifies every listener, coalescing a burst of writes into one', async () => {
  const w = createTranscriptWatcher({ debounceMs: 50, checkMs: 60_000 });
  const p = await tempFile();
  let a = 0;
  let b = 0;
  const offA = w.subscribe(p, () => a++);
  const offB = w.subscribe(p, () => b++);
  await sleep(50);
  await appendFile(p, '{"type":"assistant"}\n');
  await appendFile(p, '{"type":"assistant"}\n');
  await until(() => a, 1);
  await until(() => b, 1);
  await sleep(200);
  assert.equal(a, 1);
  assert.equal(b, 1);
  offA();
  offB();
});

test('one watcher per path, closed with its last listener', async () => {
  const w = createTranscriptWatcher({ debounceMs: 20, checkMs: 60_000 });
  const p = await tempFile();
  const off1 = w.subscribe(p, () => {});
  const off2 = w.subscribe(p, () => {});
  assert.deepEqual(w.watched(), [p]);
  off1();
  assert.deepEqual(w.watched(), [p]);
  off2();
  assert.deepEqual(w.watched(), []);
  off2(); // twice is harmless
});

test('an unsubscribed listener hears nothing more', async () => {
  const w = createTranscriptWatcher({ debounceMs: 20, checkMs: 60_000 });
  const p = await tempFile();
  let n = 0;
  const keep = w.subscribe(p, () => {});
  const off = w.subscribe(p, () => n++);
  off();
  await appendFile(p, 'x\n');
  await sleep(300);
  assert.equal(n, 0);
  keep();
});

test('the periodic check catches a file that is replaced, and keeps watching the new one', async () => {
  const w = createTranscriptWatcher({ debounceMs: 20, checkMs: 100 });
  const p = await tempFile();
  let n = 0;
  const off = w.subscribe(p, () => n++);
  await sleep(50);
  const tmp = `${p}.new`;
  await writeFile(tmp, '{"type":"user"}\n{"type":"assistant"}\n');
  await rename(tmp, p);
  await until(() => n, 1);
  const before = n;
  await sleep(150);
  await appendFile(p, '{"type":"assistant"}\n');
  await until(() => n, before + 1);
  off();
});

test('a path that does not exist yet is noticed once it appears', async () => {
  const w = createTranscriptWatcher({ debounceMs: 20, checkMs: 100 });
  const dir = await mkdtemp(join(tmpdir(), 'wh-transcript-watch-'));
  dirs.push(dir);
  const p = join(dir, 'later.jsonl');
  let n = 0;
  const off = w.subscribe(p, () => n++);
  await sleep(150);
  await writeFile(p, '{"type":"user"}\n');
  await until(() => n, 1);
  off();
});
