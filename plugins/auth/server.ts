import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Context } from 'hono';
import { dirname, join } from 'node:path';
import { publicHost, publicOrigin, type ServerPluginContext, type Source } from '../../plugin-api/server.ts';
import { createAuth, loadOrCreateToken } from './auth.ts';
import { certStatus } from './certStatus.ts';
import { FailureBrake } from './failureBrake.ts';
import { sqliteFailureStore } from './failureStore.ts';
import { createPasskeys, type PasskeyRoutes } from './passkeys.ts';
import type { AuthStatus } from './types.ts';

/** Reachable without signing in: the sign-in page and its endpoints, the static bundles (code only, no data), the CA. */
export const PUBLIC_PATHS = ['/login', '/login/*', '/assets/*', '/ca.pem'];

/** Where the build puts this plugin's `webEntries.login` page (server/plugins/generateWebModule.ts). */
const LOGIN_PAGE = join('dist', 'plugin-entries', 'login.html');

function defaultCaCert(): string {
  const home = process.env.HOME ?? homedir();
  // mkcert's CAROOT default per platform (`mkcert -CAROOT`; the CAROOT env var overrides it there and here).
  if (process.env.CAROOT) return join(process.env.CAROOT, 'rootCA.pem');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'mkcert', 'rootCA.pem');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'mkcert', 'rootCA.pem');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'mkcert', 'rootCA.pem');
}

export interface AuthSettings {
  tokenFile: string;
  caCertFile: string;
  tlsDir: string;
  sessionDays: number;
}

/** Settings via `ctx.config.get` (`WORK_HUB_AUTH_<KEY>` or plugins.json `settings.auth`); the old env names still count. */
export function authSettings(ctx: ServerPluginContext): AuthSettings {
  const env = process.env;
  return {
    tokenFile: ctx.config.get('tokenFile', env.WORK_HUB_TOKEN_FILE ?? join(ctx.paths.stateDir, 'token')),
    // The public root CA certificate served at /ca.pem so phones can install it. Never point this at a key.
    caCertFile: ctx.config.get('caCertFile', env.WORK_HUB_CA_CERT ?? defaultCaCert()),
    tlsDir: ctx.config.get('tlsDir', env.WORK_HUB_TLS_DIR ?? join(ctx.paths.stateDir, 'tls')),
    sessionDays: ctx.config.get('sessionDays', Number(env.WORK_HUB_SESSION_DAYS ?? 7)),
  };
}

export default function register(ctx: ServerPluginContext): void {
  const s = authSettings(ctx);
  const token = loadOrCreateToken(s.tokenFile);
  // 10 failures per 10 minutes, globally (single-user app), kept in SQLite so a restart doesn't reset it.
  const brake = new FailureBrake(sqliteFailureStore(() => ctx.db.raw()));
  const auth = createAuth({ token, sessionDays: s.sessionDays, brake });
  // WebAuthn needs a real hostname (its RP ID; IP addresses are refused), so without one only token and pairing work.
  const passkeys = publicHost
    ? createPasskeys({ rpID: publicHost, origin: publicOrigin, file: join(dirname(s.tokenFile), 'passkeys.json'), auth })
    : null;
  if (!publicHost) ctx.log.warn('on without WORK_HUB_HOSTNAME: token and pairing sign-in work, passkeys need a hostname');

  ctx.auth.setProvider({ isAuthed: (c) => auth.isAuthed(c), publicPaths: PUBLIC_PATHS });

  const app = ctx.app;
  // The sign-in page (a second Vite entry, `webEntries` in plugin.json). Vite serves it itself in dev.
  app.get('/login', async (c) => {
    const html = await readFile(join(ctx.paths.repoRoot, LOGIN_PAGE), 'utf8').catch(() => null);
    if (html === null) return c.text('the sign-in page is not built: run pnpm build', 404);
    return c.html(html, 200, { 'Cache-Control': 'no-cache' });
  });
  app.post('/login', (c) => auth.handleLogin(c));
  app.post('/login/pair', (c) => auth.redeemPairing(c));
  app.post('/api/pair', (c) => auth.createPairing(c));
  app.post('/api/logout', (c) => auth.handleLogout(c));

  // A TLS front asks this before serving other apps on the same origin (Caddy forward_auth). Reaching it means the
  // guard passed (right host, signed in); otherwise the guard answered with a redirect to /login.
  app.get('/auth-check', (c) => c.body(null, 204));

  // The public root CA certificate (not its key), so a phone can install it and trust this site.
  app.get('/ca.pem', async (c) => {
    const pem = await readFile(s.caCertFile, 'utf8').catch(() => null);
    if (!pem?.includes('BEGIN CERTIFICATE') || pem.includes('PRIVATE KEY')) return c.text('no CA certificate configured', 404);
    return c.body(pem, 200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="work-hub-rootCA.crt"',
    });
  });

  // Without a hostname there are no passkeys: listing says none, the rest explain why.
  const pk =
    (fn: (p: PasskeyRoutes, c: Context) => Response | Promise<Response>) =>
    async (c: Context): Promise<Response> =>
      passkeys ? fn(passkeys, c) : c.json({ error: 'passkeys need WORK_HUB_HOSTNAME set' }, 400);
  app.post('/login/passkey/options', pk((p, c) => p.loginOptions(c)));
  app.post('/login/passkey/verify', pk((p, c) => p.loginVerify(c)));
  app.get('/api/passkeys', (c) => (passkeys ? passkeys.listPasskeys(c) : c.json([])));
  app.post('/api/passkeys/delete', pk((p, c) => p.deletePasskey(c)));
  app.post('/api/passkeys/register/options', pk((p, c) => p.registrationOptions(c)));
  app.post('/api/passkeys/register/verify', pk((p, c) => p.registrationVerify(c)));

  // The certificate's expiry, for the Status page and the health dot (also the `auth` source, which rides the SSE stream).
  const status = () => certStatus(publicHost, s.tlsDir);
  app.get('/api/plugins/auth/status', async (c) => c.json(await status()));
  const source: Source<AuthStatus> = { id: 'auth', title: 'Sign-in', intervalMs: 3600_000, local: true, fetch: status };
  ctx.registry.add(source);
}
