/**
 * The access guard (fixed core, not a plugin). The API can type into terminals running Claude, so it's effectively remote
 * code execution:
 * 1. Host must be one the app answers on (`acceptedAuthorities`: 127.0.0.1/localhost:<port> in localhost mode, else the
 *    public hostname), which refuses raw IPs, other names and DNS rebinding.
 *    In localhost mode a request carrying X-Forwarded-For/-Host, Forwarded, X-Real-IP or CF-Connecting-IP (a tunnel or
 *    reverse proxy) is refused too.
 * 1b. In localhost mode a GET to /api/* that a browser marks as coming from another site (`Sec-Fetch-Site` other than
 *    same-origin/none) is refused: some GETs start work (/api/events wakes token-spending polling, the slash-command
 *    list runs `claude -p`), and another local web page, even on another localhost port, must not trigger them.
 * 2. Writes must be JSON with no Origin or an accepted one (CSRF). WebSocket routes check Origin themselves.
 * 3. Signing in is the auth provider's job (the `auth` plugin's): without one every request is allowed, which is only
 *    safe in localhost mode, so `assertStartupSafe` refuses a public hostname without a provider.
 */
import type { Context, Hono } from 'hono';
import type { AuthProvider } from '../plugin-api/server.ts';

export interface GuardOptions {
  acceptedAuthorities: readonly string[];
  isAcceptedOrigin(origin: string): boolean;
  /** Read per request: plugins set it after the guard is installed. */
  provider(): AuthProvider | null;
  /** Extra public paths (`ctx.guard.addPublicPaths`), read per request. */
  publicPaths(): readonly string[];
  /** No hostname set. Default: every accepted authority is 127.0.0.1:<port> or localhost:<port>. */
  localhostMode?: boolean;
}

export const PROXIED_IN_LOCALHOST_MODE = 'proxied request in localhost mode; set WORK_HUB_HOSTNAME and enable the auth plugin';
/** Headers a reverse proxy or tunnel adds. In localhost mode nothing should sit in front of the app. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
export const CROSS_SITE_GET = 'cross-site request refused';
/** Browsers send Sec-Fetch-Site on every request; these two are the app's own pages and typed-in URLs or bookmarks. */
const OWN_FETCH_SITES = new Set(['same-origin', 'none']);

/** `/x` matches exactly; `/x/*` (or any pattern ending in `*`) matches by prefix. */
export function matchesPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p));
}

function defaultUnauthed(c: Context): Response {
  return c.req.path.startsWith('/api/') ? c.json({ error: 'not signed in' }, 401) : c.redirect('/login');
}

export function installGuard(app: Hono, o: GuardOptions): void {
  const localhostMode = o.localhostMode ?? o.acceptedAuthorities.every((a) => /^(127\.0\.0\.1|localhost):\d+$/.test(a));
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!host || !o.acceptedAuthorities.includes(host)) return c.text('forbidden host', 403);
    // A tunnel or reverse proxy that rewrites Host to 127.0.0.1 would otherwise put the app, with no sign-in, on the network.
    if (localhostMode && PROXY_HEADERS.some((h) => c.req.header(h) !== undefined)) return c.text(PROXIED_IN_LOCALHOST_MODE, 403);
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && localhostMode && c.req.path.startsWith('/api/')) {
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && !OWN_FETCH_SITES.has(site)) return c.text(CROSS_SITE_GET, 403);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && !o.isAcceptedOrigin(origin)) return c.text('forbidden origin', 403);
      if (!c.req.header('content-type')?.includes('application/json')) return c.text('json required', 415);
    }
    const provider = o.provider();
    if (!provider) return next();
    if (matchesPath(c.req.path, [...(provider.publicPaths ?? []), ...o.publicPaths()])) return next();
    if (!(await provider.isAuthed(c))) return provider.onUnauthed ? provider.onUnauthed(c) : defaultUnauthed(c);
    await next();
  });
}

export const NO_AUTH_WITH_HOSTNAME =
  'WORK_HUB_HOSTNAME is set but the auth plugin is off: enable it in plugins.json or unset the hostname';

/** Called once plugins have loaded: a public hostname without an auth provider would serve the LAN with no sign-in. */
export function assertStartupSafe(o: { publicHost: string | undefined; provider: AuthProvider | null }): void {
  if (o.publicHost && !o.provider) throw new Error(NO_AUTH_WITH_HOSTNAME);
}
