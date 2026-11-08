/**
 * Every API route the core itself serves (index.ts, the loader's `/api/plugins`, configRoute.ts, settingsRoute.ts, applyRoute.ts, setupRoute.ts, worktreeRoutes.ts), as `METHOD /path`.
 * Plugins load before the core routes are added, so a plugin route that would also match one of these would shadow the
 * core's: the loader refuses it and skips the plugin (`routeConflicts`). Plugins put their routes under
 * `/api/plugins/<id>/...` (always allowed) or a path of their own that no core route matches.
 * `coreRoutes.test.ts` checks this list against the `app.<method>('/api/...')` calls in those files.
 * Kept in its own module (re-exported from index.ts) because index.ts starts the server when imported.
 */
export const CORE_ROUTES: readonly string[] = [
  'GET /api/plugins',
  'GET /api/plugins/config',
  'POST /api/plugins/config',
  'GET /api/settings',
  'POST /api/settings',
  'GET /api/server/apply',
  'POST /api/server/apply',
  'GET /api/setup',
  'GET /api/setup/checks',
  'POST /api/setup',
  'POST /api/setup/skip',
  'GET /api/layout',
  'POST /api/layout',
  'GET /api/state',
  'GET /api/status',
  'POST /api/sources/:id/refresh',
  'GET /api/events',
  'POST /api/sessions',
  'GET /api/sessions/:id/file-edits',
  'GET /api/sessions/:id/tasks',
  'POST /api/sessions/:id/seen',
  'POST /api/sessions/:id/name',
  'POST /api/sessions/:id/send',
  'POST /api/sessions/:id/key',
  'POST /api/sessions/:id/trash',
  'POST /api/workspaces/:id/status',
  'POST /api/workspaces/:id/title',
  'POST /api/workspaces/:id/sessions',
  'POST /api/workspaces/:id/sessions/:sid/close',
  'GET /api/workspaces/:id/worktrees',
  'POST /api/workspaces/:id/worktrees/remove',
  'POST /api/jobs/:id/dismiss',
];

/** `/api/sessions/:sid/send` and `/api/sessions/:id/send` are the same route: parameter names don't count. */
export function routeShape(path: string): string {
  return path.replace(/\/:[^/]+/g, '/:').replace(/\/+$/, '') || '/';
}

/** `GET /api/x` → { method: 'GET', path: '/api/x' }; a bare path stands for every method. */
function parseCore(route: string): { method: string; path: string } {
  const m = /^([A-Za-z]+)\s+(\/.*)$/.exec(route.trim());
  return m ? { method: m[1].toUpperCase(), path: m[2] } : { method: 'ALL', path: route.trim() };
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

const isParam = (s: string) => s.startsWith(':');
const isOptional = (s: string) => isParam(s) && s.endsWith('?');

/**
 * Could the plugin pattern `p` match the concrete-or-parameterised core path `c`? In the plugin's pattern, `:param` matches
 * any one segment, `:param?` zero or one, and `*` any number (zero included, like Hono's trailing `*`). A `:param` in the
 * core path matches any one plugin segment (a plugin literal there would still take that one value away from the core).
 */
function segmentsMatch(p: string[], c: string[]): boolean {
  if (p.length === 0) return c.length === 0;
  const [head, ...rest] = p;
  if (head === '*') {
    for (let i = 0; i <= c.length; i++) if (segmentsMatch(rest, c.slice(i))) return true;
    return false;
  }
  if (isOptional(head) && segmentsMatch(rest, c)) return true;
  if (c.length === 0) return false;
  const ok = isParam(head) || isParam(c[0]) || head === c[0];
  return ok && segmentsMatch(rest, c.slice(1));
}

/**
 * The core route (as listed in `coreRoutes`) that a plugin route `pluginMethod pluginPath` would also match, if any.
 * Methods must agree unless either side is `ALL` (Hono's `all`). Paths compare by segments, with the plugin's `:param`,
 * `:param?` and `*` matching any core segment(s). `/api/plugins/<id>/...` (a literal id) never conflicts: no core route
 * lives below `/api/plugins/<x>/` (the test keeps it that way), so the plugin namespace is always free.
 */
export function routeConflicts(pluginMethod: string, pluginPath: string, coreRoutes: readonly string[] = CORE_ROUTES): string | undefined {
  const method = pluginMethod.toUpperCase();
  const p = segments(pluginPath);
  return coreRoutes.find((route) => {
    const core = parseCore(route);
    if (method !== 'ALL' && core.method !== 'ALL' && method !== core.method) return false;
    return segmentsMatch(p, segments(core.path));
  });
}
