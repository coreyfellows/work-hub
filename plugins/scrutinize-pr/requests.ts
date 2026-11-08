import { watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Requests from the /work-hub:scrutinize-pr skill (skills/scrutinize-pr/scrutinize-pr.ts). The skill drops `<id>.json` in the
 * plugin's `requests/` folder (0700, in the state dir); the server takes it (deleting it), hands it to `handle`, and
 * answers in `<id>.response.json`, which the handler may rewrite as the job moves on. Answers older than a day are
 * cleaned up; a request older than an hour (work-hub was down) is refused rather than started late.
 */

export type Respond = (body: Record<string, unknown>) => Promise<void>;
export type RequestHandler = (req: unknown, respond: Respond) => Promise<void>;

const REQUEST = /^[A-Za-z0-9-]{8,64}\.json$/;
const DAY = 86_400_000;
const STALE = 3_600_000;

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

/** One pass over the folder: take every new request, clean up old answers. */
export async function processRequests(dir: string, handle: RequestHandler, now = Date.now()): Promise<number> {
  let n = 0;
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (name.endsWith('.response.json')) {
      const st = await stat(path).catch(() => null);
      if (st && now - st.mtimeMs > DAY) await unlink(path).catch(() => {});
      continue;
    }
    if (!REQUEST.test(name)) continue;
    const id = name.slice(0, -'.json'.length);
    let req: unknown = null;
    try {
      req = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      /* answered below */
    }
    // Taken: gone before anything slow, so the next pass can't start it twice.
    if (!(await unlink(path).then(() => true, () => false))) continue;
    n++;
    const respond: Respond = (body) => writeAtomic(join(dir, `${id}.response.json`), JSON.stringify({ id, ...body, at: new Date().toISOString() }, null, 1));
    const at = Date.parse(String((req as { requestedAt?: unknown } | null)?.requestedAt ?? ''));
    if (!req || typeof req !== 'object') await respond({ status: 'failed', error: 'unreadable request' });
    else if (!Number.isFinite(at) || now - at > STALE) await respond({ status: 'failed', error: 'the request is over an hour old (was work-hub down?); ask again' });
    else await handle(req, respond).catch((e: Error) => respond({ status: 'failed', error: e.message }));
  }
  return n;
}

/** Watch `dir` (created 0700): a pass on every change, and every 10s in case a change event was missed. Returns stop(). */
export async function watchRequests(dir: string, handle: RequestHandler, onError: (e: unknown) => void): Promise<() => void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let busy = false;
  let again = false;
  const pass = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await processRequests(dir, handle).catch(onError);
      } while (again);
    } finally {
      busy = false;
    }
  };
  const w = watch(dir, () => void pass());
  w.on('error', onError);
  const timer = setInterval(() => void pass(), 10_000);
  timer.unref?.();
  void pass();
  return () => {
    w.close();
    clearInterval(timer);
  };
}
