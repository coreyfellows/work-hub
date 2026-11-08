import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const dir = mkdtempSync(join(tmpdir(), 'wh-migrate-'));
process.env.WORK_HUB_STATE_DIR = dir;
const { migrate, MIGRATIONS } = await import('./db.ts');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const open = (file: string) => {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return d;
};
const version = (d: DatabaseSync) => (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('migrate on an up-to-date database is a no-op, from the same or another connection', () => {
  const file = join(dir, 'twice.db');
  const a = open(file);
  migrate(a);
  a.prepare("INSERT INTO workspaces (id, title, origin) VALUES ('w', 'W', 'prompt')").run();
  a.prepare("INSERT INTO worktrees (workspace_id, path, vcs) VALUES ('w', '/jj', 'jj')").run();
  migrate(a);
  const b = open(file);
  migrate(b);
  assert.equal(version(b), MIGRATIONS.length);
  assert.equal((b.prepare("SELECT vcs FROM worktrees WHERE path = '/jj'").get() as { vcs: string }).vcs, 'jj');
  a.close();
  b.close();
});

test('a process that read an old version while another migrated does not run the steps again', async () => {
  const file = join(dir, 'race.db');
  const a = open(file);
  migrate(a, 16);
  // Another process takes the write lock and starts migrating; it hasn't committed yet.
  a.exec('BEGIN IMMEDIATE');
  // The second process opens the file, reads version 16 (WAL: readers see the last commit) and calls migrate.
  const dbUrl = new URL('./db.ts', import.meta.url).href;
  const w = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const { DatabaseSync } = require('node:sqlite');
     (async () => {
       const { migrate } = await import(workerData.dbUrl);
       const d = new DatabaseSync(workerData.file);
       d.exec('PRAGMA busy_timeout = 5000;');
       parentPort.postMessage('ready');
       try { migrate(d); parentPort.postMessage({ ok: true }); } catch (e) { parentPort.postMessage({ ok: false, error: String(e) }); }
       d.close();
     })();`,
    { eval: true, workerData: { file, dbUrl }, env: { ...process.env, WORK_HUB_STATE_DIR: dir } },
  );
  await once(w, 'message'); // 'ready'
  const result = once(w, 'message');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // let the worker read the old version and wait on the lock
  for (let v = 16; v < MIGRATIONS.length; v++) a.exec(MIGRATIONS[v]);
  a.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  a.prepare("INSERT INTO workspaces (id, title, origin) VALUES ('w', 'W', 'prompt')").run();
  a.prepare("INSERT INTO worktrees (workspace_id, path, vcs) VALUES ('w', '/jj', 'jj')").run();
  a.exec('COMMIT');
  const [r] = (await result) as [{ ok: boolean; error?: string }];
  await once(w, 'exit');
  assert.deepEqual(r, { ok: true });
  assert.equal(version(a), MIGRATIONS.length);
  // Re-running migration 17 would have reset it to git (and 18 would then fail on its duplicate column).
  assert.equal((a.prepare("SELECT vcs FROM worktrees WHERE path = '/jj'").get() as { vcs: string }).vcs, 'jj');
  a.close();
});
