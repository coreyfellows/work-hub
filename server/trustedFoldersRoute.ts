/** `POST /api/trusted-folders { path }`: confirm a plain folder for `claude --bg` (stored by realpath). */
import { realpath, stat } from 'node:fs/promises';
import type { Hono } from 'hono';
import { expandFolder, folderTrustError } from './lib/folders.ts';
import { readJson } from './lib/http.ts';
import { trustFolder } from './store/workspaces.ts';

export function registerTrustedFolderRoutes(app: Hono, opts: { trust?: (realPath: string) => void; home?: string } = {}): void {
  const trust = opts.trust ?? trustFolder;
  app.post('/api/trusted-folders', async (c) => {
    const { path } = await readJson<{ path?: unknown }>(c);
    const bad = folderTrustError(path, opts.home);
    if (bad) return c.json({ error: bad }, 400);
    const real = await realpath(expandFolder(path as string, opts.home)).catch(() => null);
    const isDir = real ? await stat(real).then((s) => s.isDirectory(), () => false) : false;
    if (!real || !isDir) return c.json({ error: `not a directory: ${path}` }, 400);
    const bad2 = folderTrustError(real, opts.home);
    if (bad2) return c.json({ error: bad2 }, 400);
    trust(real);
    return c.json({ path: real });
  });
}
