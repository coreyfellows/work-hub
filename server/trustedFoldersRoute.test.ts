import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { registerTrustedFolderRoutes } from './trustedFoldersRoute.ts';

test('POST /api/trusted-folders: refuses symlinks into system folders and files, stores the realpath of a good folder', async () => {
  // Under the checkout (inside the home folder), not tmpdir: /private/var is itself refused.
  const base = await realpath(await mkdtemp(join(process.cwd(), '.wh-trusted-')));
  try {
    const stored: string[] = [];
    const app = new Hono();
    registerTrustedFolderRoutes(app, { trust: (p) => void stored.push(p) });
    const post = (path: unknown) =>
      app.request('/api/trusted-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    await symlink('/usr', join(base, 'to-usr'));
    await writeFile(join(base, 'file'), 'x');
    const good = join(base, 'good');
    await mkdir(good);
    await symlink(good, join(base, 'to-good'));

    assert.equal((await post(join(base, 'to-usr'))).status, 400);
    assert.equal((await post(join(base, 'file'))).status, 400);
    assert.equal((await post(join(base, 'missing'))).status, 400);
    assert.deepEqual(stored, []);
    const r = await post(join(base, 'to-good'));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { path: good });
    assert.deepEqual(stored, [good]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
