/**
 * The auth plugin's register() with a light fake context: the provider it sets, token sign-in, the brake, pairing and
 * the sign-in page. Run behind the real guard (server/guard.ts is core, so it's not imported: the provider is enough).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';
import { Hono } from 'hono';
import type { AuthProvider, ServerPluginContext } from '../../plugin-api/server.ts';
import { cookieFor, createAuth } from './auth.ts';
import register, { PUBLIC_PATHS } from './server.ts';

let app: Hono;
let provider: AuthProvider | null = null;
let root: string;
const sources: string[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), 'wh-auth-'));
  mkdirSync(join(root, 'dist', 'plugin-entries'), { recursive: true });
  writeFileSync(join(root, 'dist', 'plugin-entries', 'login.html'), '<h1>sign in</h1>');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE auth_failures (at INTEGER NOT NULL)');
  app = new Hono();
  // Stand-in for the guard: public paths pass, everything else needs the provider's yes.
  app.use('*', async (c, next) => {
    const p = c.req.path;
    const pub = PUBLIC_PATHS.some((x) => (x.endsWith('*') ? p.startsWith(x.slice(0, -1)) : p === x));
    if (!pub && provider && !(await provider.isAuthed(c))) return c.json({ error: 'not signed in' }, 401);
    await next();
  });
  const ctx = {
    id: 'auth',
    app,
    paths: { stateDir: join(root, 'state'), repoRoot: root },
    config: { get: (_k: string, d: unknown) => d },
    db: { raw: () => db },
    auth: { setProvider: (p: AuthProvider) => void (provider = p) },
    registry: { add: (s: { id: string }) => void sources.push(s.id) },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ServerPluginContext;
  register(ctx);
});

const tokenFile = () => join(root, 'state', 'token');
const token = () => readFileSync(tokenFile(), 'utf8').trim();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('creates the token 0600 in a 0700 state dir, sets the provider and the auth source', () => {
  assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'state')).mode & 0o777, 0o700);
  assert.ok(provider);
  assert.deepEqual(provider!.publicPaths, PUBLIC_PATHS);
  assert.deepEqual(sources, ['auth']);
});

test('the sign-in page is public and served from the build', async () => {
  const r = await app.request('http://x/login');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<h1>sign in</h1>');
});

test('token sign-in sets the cookie the provider accepts; a wrong token is refused', async () => {
  assert.equal((await post('/login', { token: 'nope' })).status, 401);
  assert.equal((await post('/login', { token: 12 })).status, 401, 'a non-string token is just wrong');
  const ok = await post('/login', { token: token() });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie') ?? '';
  assert.match(cookie, new RegExp(`^wh_auth=${cookieFor(token())};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await app.request('http://x/api/plugins/auth/status')).status, 401);
  const authed = await app.request('http://x/api/plugins/auth/status', { headers: { cookie: `wh_auth=${cookieFor(token())}` } });
  assert.equal(authed.status, 200);
  assert.deepEqual(await authed.json(), { hostname: null, certDays: null, certFile: null });
});

test('a pairing code signs one device in once', async () => {
  const signedIn = { cookie: `wh_auth=${cookieFor(token())}` };
  const { code } = (await (await post('/api/pair', {}, signedIn)).json()) as { code: string };
  assert.equal((await post('/login/pair', { code })).status, 200);
  assert.equal((await post('/login/pair', { code })).status, 401, 'single use');
});

test('without a hostname there are no passkeys', async () => {
  const signedIn = { cookie: `wh_auth=${cookieFor(token())}` };
  assert.deepEqual(await (await app.request('http://x/api/passkeys', { headers: signedIn })).json(), []);
  assert.equal((await post('/login/passkey/options', {})).status, 400);
});

test('an empty token in the request is refused even before comparing', async () => {
  assert.equal((await post('/login', { token: '' })).status, 401);
  assert.equal((await post('/login', { token: '   ' })).status, 401);
});

test('the brake refuses sign-in after 10 failures, even with the right token', async () => {
  for (let i = 0; i < 10; i++) await post('/login', { token: 'wrong' });
  assert.equal((await post('/login', { token: token() })).status, 429);
});


test('a token file that is empty or too short makes register() throw (fail closed), not sign everyone in', () => {
  for (const content of ['', '  \n', 'short']) {
    const dir = mkdtempSync(join(tmpdir(), 'wh-auth-short-'));
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'token'), content);
    let set = false;
    const ctx = {
      id: 'auth',
      app: new Hono(),
      paths: { stateDir: join(dir, 'state'), repoRoot: dir },
      config: { get: (_k: string, d: unknown) => d },
      db: { raw: () => new DatabaseSync(':memory:') },
      auth: { setProvider: () => void (set = true) },
      registry: { add() {} },
      log: { info() {}, warn() {}, error() {} },
    } as unknown as ServerPluginContext;
    assert.throws(() => register(ctx), /empty or shorter than 16 characters/, JSON.stringify(content));
    assert.equal(set, false, 'no provider was set');
    assert.equal(readFileSync(join(dir, 'state', 'token'), 'utf8'), content, 'the file is left for the owner to fix');
  }
  assert.throws(() => createAuth({ token: '', sessionDays: 7, brake: {} as never }), /shorter than 16/);
});
