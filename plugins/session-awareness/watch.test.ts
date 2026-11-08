import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchDb } from './watch.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(20);
}

test('watchDb fires once per burst and keeps firing after the wal file is replaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-watch-'));
  const db = join(dir, 'hub.db');
  writeFileSync(db, 'db');
  writeFileSync(join(dir, 'unrelated.txt'), 'x');
  // macOS delivers events from just before a watch started (FSEvents coalescing): let the setup writes settle first.
  await sleep(300);
  let fired = 0;
  const stop = watchDb(db, () => void fired++, 100);
  try {
    await sleep(150);
    writeFileSync(join(dir, 'unrelated.txt'), 'y');
    await sleep(250);
    assert.equal(fired, 0, 'other files are ignored');

    appendFileSync(join(dir, 'hub.db-wal'), 'a');
    appendFileSync(join(dir, 'hub.db-wal'), 'b');
    appendFileSync(db, 'c');
    await until(() => fired >= 1);
    await sleep(250);
    assert.equal(fired, 1, 'a burst of writes is one callback');

    rmSync(join(dir, 'hub.db-wal'));
    await sleep(250);
    const before = fired;
    writeFileSync(join(dir, 'hub.db-wal'), 'fresh');
    await until(() => fired > before);
    assert.ok(fired > before, 'a recreated wal file still fires');
  } finally {
    stop();
  }
});
