/**
 * The access guard (server/guard.ts) as the server wires it: localhost mode with no hostname, and the refusal to run a
 * hostname without an auth provider. An in-memory Hono app with the guard, a couple of routes and a fake provider.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AuthProvider, ServerPluginContext } from '../plugin-api/server.ts';
import { cookieFor } from '../plugins/auth/auth.ts';
import registerAuth from '../plugins/auth/server.ts';
import { accessFor, devMode } from './config.ts';
import { assertStartupSafe, CROSS_SITE_GET, installGuard, matchesPath, NO_AUTH_WITH_HOSTNAME, PROXIED_IN_LOCALHOST_MODE } from './guard.ts';

function appFor(o: { publicHost?: string; provider?: AuthProvider | null; dev?: boolean }) {
  const access = accessFor({ publicHost: o.publicHost, publicPort: 443, port: 4858, devWebPort: 4859, dev: o.dev });
  const app = new Hono();
  installGuard(app, {
    acceptedAuthorities: access.acceptedAuthorities,
    isAcceptedOrigin: (origin) => access.acceptedOrigins.includes(origin),
    provider: () => o.provider ?? null,
    publicPaths: () => [],
  });
  app.get('/api/status', (c) => c.json({ ok: true }));
  app.get('/api/state', (c) => c.json({}));
  app.post('/api/layout', (c) => c.json({ ok: true }));
  app.get('/login', (c) => c.html('<h1>sign in</h1>'));
  app.get('/assets/app.js', (c) => c.text('code'));
  app.get('/', (c) => c.html('app'));
  return { app, access };
}

const req = (app: Hono, path: string, headers: Record<string, string>, init: RequestInit = {}) =>
  app.request(`http://x${path}`, { ...init, headers });

// --- (a) no hostname: localhost mode -------------------------------------------------------------

test('localhost mode: 127.0.0.1 and localhost on the port are accepted without any cookie', async () => {
  const { app } = appFor({});
  assert.equal((await req(app, '/api/status', { host: '127.0.0.1:4858' })).status, 200);
  assert.equal((await req(app, '/api/state', { host: 'localhost:4858' })).status, 200);
  assert.equal((await req(app, '/', { host: '127.0.0.1:4858' })).status, 200);
});

test('localhost mode: any other Host is refused (raw IPs, other names, other ports, DNS rebinding)', async () => {
  const { app } = appFor({});
  for (const host of ['evil', 'evil.example:4858', '192.168.1.20:4858', '127.0.0.1:4848', '127.0.0.1', 'localhost']) {
    assert.equal((await req(app, '/api/status', { host })).status, 403, host);
  }
  assert.equal((await app.request('http://x/api/status')).status, 403, 'no Host header at all');
});

test('localhost mode: writes need JSON and no Origin or an accepted one', async () => {
  const { app } = appFor({});
  const post = (headers: Record<string, string>) => req(app, '/api/layout', { host: '127.0.0.1:4858', ...headers }, { method: 'POST', body: '{}' });
  assert.equal((await post({ 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'http://127.0.0.1:4848' })).status, 403, 'another port is another origin');
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://127.0.0.1:4858' })).status, 403, 'scheme counts');
  assert.equal((await post({ 'content-type': 'application/json', origin: 'http://127.0.0.1:4858' })).status, 200);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'http://localhost:4858' })).status, 200);
  assert.equal((await post({ 'content-type': 'application/json' })).status, 200, 'no Origin (curl, bin/wh)');
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415, 'a form post is not JSON');
});

test('localhost mode: the Vite dev port is accepted only in development', async () => {
  assert.deepEqual(appFor({}).access.acceptedAuthorities, ['127.0.0.1:4858', 'localhost:4858']);
  const dev = appFor({ dev: true });
  assert.deepEqual(dev.access.acceptedAuthorities, ['127.0.0.1:4858', 'localhost:4858', '127.0.0.1:4859', 'localhost:4859']);
  assert.equal(dev.access.publicOrigin, 'http://127.0.0.1:4858');
  assert.equal((await req(dev.app, '/api/status', { host: '127.0.0.1:4859' })).status, 200);
});

test('dev authorities need WORK_HUB_DEV=1, not merely a missing NODE_ENV', () => {
  assert.equal(devMode({}), false);
  assert.equal(devMode({ NODE_ENV: 'development' }), false);
  assert.equal(devMode({ WORK_HUB_DEV: '1' }), true);
  assert.equal(devMode({ WORK_HUB_DEV: 'true' }), false);
});

test('localhost mode: an /api GET from another site is refused; own pages, typed URLs and non-browsers pass', async () => {
  const { app } = appFor({});
  const get = (path: string, site?: string) => req(app, path, { host: '127.0.0.1:4858', ...(site ? { 'sec-fetch-site': site } : {}) });
  for (const site of ['cross-site', 'same-site']) {
    const r = await get('/api/state', site);
    assert.equal(r.status, 403, site);
    assert.equal(await r.text(), CROSS_SITE_GET);
  }
  assert.equal((await get('/api/state', 'same-origin')).status, 200);
  assert.equal((await get('/api/state', 'none')).status, 200, 'typed into the address bar');
  assert.equal((await get('/api/state')).status, 200, 'curl and bin/wh send no Sec-Fetch-Site');
  assert.equal((await get('/', 'cross-site')).status, 200, 'pages (a link from elsewhere) still open');
});

test('hostname mode: Sec-Fetch-Site is left to the sign-in check', async () => {
  const provider: AuthProvider = { isAuthed: () => true };
  const { app } = appFor({ publicHost: 'hub.example.test', provider });
  assert.equal((await req(app, '/api/state', { host: 'hub.example.test', 'sec-fetch-site': 'cross-site' })).status, 200);
});

// --- (b) hostname set, no auth provider: refuse to start -----------------------------------------

test('a hostname without an auth provider refuses to start; localhost mode or a provider is fine', () => {
  assert.throws(() => assertStartupSafe({ publicHost: 'example.test', provider: null }), (e: Error) => {
    assert.match(e.message, /^WORK_HUB_HOSTNAME is set but the auth plugin is off/);
    assert.equal(e.message, NO_AUTH_WITH_HOSTNAME);
    return true;
  });
  assert.doesNotThrow(() => assertStartupSafe({ publicHost: undefined, provider: null }));
  assert.doesNotThrow(() => assertStartupSafe({ publicHost: 'example.test', provider: { isAuthed: () => false } }));
});

// --- (c) hostname set, auth on -------------------------------------------------------------------

const fakeProvider: AuthProvider = {
  isAuthed: (c) => getCookie(c, 'wh_auth') === 'good',
  publicPaths: ['/login', '/login/*', '/assets/*', '/ca.pem'],
};

test('hostname + auth: only the hostname is accepted, and unauthenticated API calls get 401', async () => {
  const { app, access } = appFor({ publicHost: 'example.test', provider: fakeProvider });
  assert.deepEqual(access.acceptedAuthorities, ['example.test']);
  assert.equal(access.publicOrigin, 'https://example.test');
  assert.equal((await req(app, '/api/status', { host: '127.0.0.1:4858' })).status, 403, 'loopback names are refused once a hostname is set');
  const unauthed = await req(app, '/api/status', { host: 'example.test' });
  assert.equal(unauthed.status, 401);
  assert.deepEqual(await unauthed.json(), { error: 'not signed in' });
  assert.equal((await req(app, '/api/status', { host: 'example.test', cookie: 'wh_auth=bad' })).status, 401);
  assert.equal((await req(app, '/api/status', { host: 'example.test', cookie: 'wh_auth=good' })).status, 200);
});

test('hostname + auth: the sign-in page and bundles are public; other pages redirect to /login', async () => {
  const { app } = appFor({ publicHost: 'example.test', provider: fakeProvider });
  assert.equal((await req(app, '/login', { host: 'example.test' })).status, 200);
  assert.equal((await req(app, '/assets/app.js', { host: 'example.test' })).status, 200);
  const page = await req(app, '/', { host: 'example.test' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const post = await req(app, '/api/layout', { host: 'example.test', 'content-type': 'application/json', origin: 'https://example.test' }, { method: 'POST', body: '{}' });
  assert.equal(post.status, 401, 'a same-origin write still needs the cookie');
  const foreign = await req(app, '/api/layout', { host: 'example.test', 'content-type': 'application/json', origin: 'http://127.0.0.1:4858', cookie: 'wh_auth=good' }, { method: 'POST', body: '{}' });
  assert.equal(foreign.status, 403, 'the localhost origin is foreign once a hostname is set');
});

test('a public path pattern matches exactly, or by prefix with a trailing *', () => {
  const pats = ['/login', '/login/*', '/assets/*'];
  assert.ok(matchesPath('/login', pats));
  assert.ok(matchesPath('/login/pair', pats));
  assert.ok(matchesPath('/assets/x.js', pats));
  assert.ok(!matchesPath('/loginx', pats));
  assert.ok(!matchesPath('/api/login', pats));
  assert.ok(!matchesPath('/assets', pats));
});

test('localhost mode: a request a proxy or tunnel forwarded is refused', async () => {
  const { app } = appFor({});
  for (const [h, v] of [
    ['x-forwarded-for', '203.0.113.9'],
    ['x-forwarded-host', 'tunnel.example'],
    ['forwarded', 'for=203.0.113.9'],
    ['x-real-ip', '203.0.113.9'],
    ['cf-connecting-ip', '203.0.113.9'],
  ]) {
    const r = await req(app, '/api/status', { host: '127.0.0.1:4858', [h]: v });
    assert.equal(r.status, 403, h);
    assert.equal(await r.text(), PROXIED_IN_LOCALHOST_MODE);
  }
});

test('hostname mode: forwarded headers are expected (the TLS front adds them) and pass to sign-in', async () => {
  const { app } = appFor({ publicHost: 'example.test', provider: fakeProvider });
  const r = await req(app, '/api/status', { host: 'example.test', 'x-forwarded-for': '192.168.1.5', cookie: 'wh_auth=good' });
  assert.equal(r.status, 200);
});

// --- the real auth plugin behind the real guard ----------------------------------------------------

test('hostname + the real auth plugin: /api/status 401 without the cookie, /login 200, 200 with the token cookie', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wh-sec-'));
  mkdirSync(join(root, 'dist', 'plugin-entries'), { recursive: true });
  writeFileSync(join(root, 'dist', 'plugin-entries', 'login.html'), '<h1>sign in</h1>');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE auth_failures (at INTEGER NOT NULL)');
  const access = accessFor({ publicHost: 'example.test', publicPort: 443, port: 4858 });
  const app = new Hono();
  let provider: AuthProvider | null = null;
  const publicPaths: string[] = [];
  installGuard(app, {
    acceptedAuthorities: access.acceptedAuthorities,
    isAcceptedOrigin: (origin) => access.acceptedOrigins.includes(origin),
    provider: () => provider,
    publicPaths: () => publicPaths,
  });
  const ctx = {
    id: 'auth',
    app,
    paths: { stateDir: join(root, 'state'), repoRoot: root },
    config: { get: (_k: string, d: unknown) => d },
    db: { raw: () => db },
    auth: { setProvider: (p: AuthProvider) => void (provider = p) },
    guard: { addPublicPaths: (p: string[]) => void publicPaths.push(...p) },
    registry: { add: () => {} },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ServerPluginContext;
  registerAuth(ctx);
  app.get('/api/status', (c) => c.json({ ok: true })); // a core route, registered after the plugins as in index.ts
  assert.doesNotThrow(() => assertStartupSafe({ publicHost: 'example.test', provider }));

  const host = { host: 'example.test' };
  assert.equal((await req(app, '/api/status', host)).status, 401);
  assert.equal((await req(app, '/login', host)).status, 200);
  const token = readFileSync(join(root, 'state', 'token'), 'utf8').trim();
  assert.equal((await req(app, '/api/status', { ...host, cookie: `wh_auth=${cookieFor(token)}` })).status, 200);
  assert.equal((await req(app, '/api/status', { ...host, cookie: `wh_auth=${cookieFor('')}` })).status, 401, 'the empty-token cookie is not a key');
  const empty = await req(app, '/login', { ...host, 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ token: '  ' }) });
  assert.equal(empty.status, 401);
});
