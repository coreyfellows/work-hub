/**
 * The core's own static page paths (App.tsx's `path === '…'` routes). staticRoute.test.ts fails when App.tsx routes a
 * static path that isn't listed here, so a new core page can't be shadowed by a plugin page by accident.
 */
export const CORE_STATIC_PATHS: readonly string[] = ['/', '/workspaces', '/settings', '/status'];

/**
 * Route precedence: a `page` slot item with a static path (a string with no `:param`) wins over the core's param routes
 * (`/workspaces/:id`, `/sessions/:id`), whatever the registration order, so a plugin can own e.g. `/workspaces/new`.
 * `reserved` are the core's own static paths: those still win, so a plugin page can't shadow them.
 */
export function staticPage<T extends { path: unknown }>(items: readonly T[], path: string, reserved: readonly string[]): T | null {
  const norm = (p: string) => '/' + p.split('/').filter(Boolean).join('/');
  const want = norm(path);
  if (reserved.some((r) => norm(r) === want)) return null;
  return items.find((i) => typeof i.path === 'string' && !i.path.includes(':') && norm(i.path) === want) ?? null;
}
