/**
 * For JSON the UI polls: an ETag plus `private, no-cache`, so the browser revalidates each poll and an unchanged
 * response comes back as an empty 304 (the page still gets the full body from its cache). GET only; never put this
 * on a streaming route (the ETag is a hash of the whole body).
 *
 * Which routes get it: `addRevalidate(paths)` (core and plugins, `ctx.revalidate`) adds Hono-style paths (`:param`
 * segments, a trailing `*`); `installRevalidate(app)` puts one middleware on the app that applies it to every path
 * added, whenever it was added. Install it before the routes so it runs ahead of them.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';

export function revalidate(): MiddlewareHandler {
  const tag = etag({ weak: true });
  return async (c, next) => {
    if (c.req.method !== 'GET') return next();
    await tag(c, next);
    if (c.res.status === 200 || c.res.status === 304) c.res.headers.set('Cache-Control', 'private, no-cache');
  };
}

const patterns: Array<{ path: string; re: RegExp }> = [];

/** `/api/sessions/:id/history` → a regex for that path exactly; a trailing `*` matches anything after. */
export function pathPattern(path: string): RegExp {
  const star = path.endsWith('*');
  const body = (star ? path.slice(0, -1) : path)
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}${star ? '.*' : ''}$`);
}

/** GET JSON routes to revalidate with an ETag. */
export function addRevalidate(paths: string[]): void {
  for (const path of paths) if (!patterns.some((p) => p.path === path)) patterns.push({ path, re: pathPattern(path) });
}

export function revalidatedPath(path: string): boolean {
  return patterns.some((p) => p.re.test(path));
}

/** The one middleware for every `addRevalidate` path (install once, before the routes). */
export function installRevalidate(app: Hono): void {
  const mw = revalidate();
  app.use('*', (c, next) => (revalidatedPath(c.req.path) ? mw(c, next) : next()));
}
