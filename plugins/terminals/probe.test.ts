import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyProbe, probeSocket } from './probe.ts';

test('classifyProbe: only ENOENT and ECONNREFUSED are absent', () => {
  assert.equal(classifyProbe({ status: 200 }), 'answered');
  assert.equal(classifyProbe({ status: 502 }), 'unclear');
  assert.equal(classifyProbe({ errorCode: 'ENOENT' }), 'absent');
  assert.equal(classifyProbe({ errorCode: 'ECONNREFUSED' }), 'absent');
  for (const code of ['ETIMEDOUT', 'EACCES', 'ECONNRESET', 'EBADREPLY', 'EUNKNOWN']) assert.equal(classifyProbe({ errorCode: code }), 'unclear', code);
});

test('probeSocket: missing file, stale file, a live server, a server that never answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'termd-probe-'));
  try {
    assert.equal(classifyProbe(await probeSocket(join(dir, 'none.sock'))), 'absent');
    writeFileSync(join(dir, 'stale.sock'), '');
    assert.notEqual(classifyProbe(await probeSocket(join(dir, 'stale.sock'))), 'answered');

    const live = join(dir, 'live.sock');
    const ok = createServer((_req, res) => res.end('[]'));
    await new Promise<void>((r) => ok.listen(live, r));
    assert.equal(classifyProbe(await probeSocket(live)), 'answered');
    ok.close();

    const slow = join(dir, 'slow.sock');
    const hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(slow, r));
    assert.equal(classifyProbe(await probeSocket(slow, 200)), 'unclear');
    hang.closeAllConnections();
    hang.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
