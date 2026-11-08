/**
 * `GET /api/settings` (every group with each field's value in force and where it comes from) and `POST /api/settings`
 * (`{ values: { "<group>.<key>": value | null } }`, null = back to the default). Behind the app's guard like any write.
 */
import type { Hono } from 'hono';
import { folderError, REPOS_KEY, WORKTREES_KEY } from './lib/folders.ts';
import { applySettings, settingsPayload } from './settings.ts';
import { setAppSetting } from './store/appSettings.ts';

export function registerSettingsRoutes(app: Hono): void {
  app.get('/api/settings', (c) => c.json(settingsPayload()));
  app.post('/api/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { values?: unknown } | null;
    // A folder setting must be an absolute path (null puts the default back).
    for (const k of [REPOS_KEY, WORKTREES_KEY]) {
      const v = (body?.values as Record<string, unknown> | undefined)?.[k];
      const bad = v === undefined || v === null ? null : folderError(v);
      if (bad) return c.json({ error: `${k.split('.')[1]}: ${bad}` }, 400);
    }
    const error = applySettings(body?.values, setAppSetting);
    if (error) return c.json({ error }, 400);
    return c.json(settingsPayload());
  });
}
