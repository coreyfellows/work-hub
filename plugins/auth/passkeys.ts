import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { readJson } from '../../plugin-api/server.ts';
import { authLog, type Auth } from './auth.ts';

/**
 * Passkeys (WebAuthn) so a device that has signed in once with the token can sign in again with
 * Face ID / Touch ID. Single user, so credentials are a small JSON file next to the token.
 * Only public keys are stored; the private key never leaves the device's secure enclave / keychain.
 */

interface StoredPasskey {
  id: string; // base64url credential id
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: string[];
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// The single user's WebAuthn handle; constant so every device's passkey belongs to the same account.
const USER_ID = new TextEncoder().encode('work-hub-owner');

export interface PasskeyRoutes {
  listPasskeys(c: Context): Response;
  deletePasskey(c: Context): Promise<Response>;
  registrationOptions(c: Context): Promise<Response>;
  registrationVerify(c: Context): Promise<Response>;
  loginOptions(c: Context): Promise<Response>;
  loginVerify(c: Context): Promise<Response>;
}

/**
 * `rpID` is the hostname (so changing it orphans every passkey), `origin` the site's https origin, `file` the JSON list
 * of public keys (0600, next to the token).
 */
export function createPasskeys(o: { rpID: string; origin: string; file: string; auth: Auth }): PasskeyRoutes {
  const { rpID, origin, auth } = o;
  const FILE = o.file;
  const { issueSession, noteFailure, tooManyFailures } = auth;

  function load(): StoredPasskey[] {
    if (!existsSync(FILE)) return [];
    return JSON.parse(readFileSync(FILE, 'utf8')) as StoredPasskey[];
  }

  function save(list: StoredPasskey[]): void {
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
  }

  // Pending challenges, keyed by an id in a short-lived cookie (one ceremony per browser at a time).
  const CHAL_COOKIE = 'wh_chal';
  const challenges = new Map<string, { challenge: string; kind: 'register' | 'login'; expires: number }>();

  function rememberChallenge(c: Context, challenge: string, kind: 'register' | 'login'): void {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
    const id = randomBytes(16).toString('base64url');
    challenges.set(id, { challenge, kind, expires: now + 5 * 60_000 });
    setCookie(c, CHAL_COOKIE, id, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 300 });
  }

  function takeChallenge(c: Context, kind: 'register' | 'login'): string | null {
    const id = getCookie(c, CHAL_COOKIE);
    deleteCookie(c, CHAL_COOKIE, { path: '/', secure: true });
    const entry = id ? challenges.get(id) : undefined;
    if (id) challenges.delete(id);
    if (!entry || entry.kind !== kind || entry.expires < Date.now()) return null;
    return entry.challenge;
  }

  const toBytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url'));

  /** Guess a friendly label for the device from its user agent. */
  function deviceLabel(c: Context): string {
    const ua = c.req.header('user-agent') ?? '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Macintosh/.test(ua)) return 'Mac';
    return 'Device';
  }

  // --- Authenticated routes (manage passkeys) -------------------------------------------------

  function listPasskeys(c: Context) {
    return c.json(load().map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt })));
  }

  async function deletePasskey(c: Context) {
    const { id } = await readJson<{ id: string }>(c);
    save(load().filter((p) => p.id !== id));
    return c.json({ ok: true });
  }

  async function registrationOptions(c: Context) {
    const options = await generateRegistrationOptions({
      rpName: 'work-hub',
      rpID,
      userName: 'work-hub',
      userDisplayName: 'work-hub',
      userID: USER_ID,
      attestationType: 'none',
      excludeCredentials: load().map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    rememberChallenge(c, options.challenge, 'register');
    return c.json(options);
  }

  async function registrationVerify(c: Context) {
    const expectedChallenge = takeChallenge(c, 'register');
    if (!expectedChallenge) return c.json({ error: 'registration expired; try again' }, 400);
    const response = await readJson<RegistrationResponseJSON>(c);
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!result.verified) return c.json({ error: 'passkey not verified' }, 400);
      const { credential } = result.registrationInfo;
      const list = load().filter((p) => p.id !== credential.id);
      list.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports,
        label: deviceLabel(c),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      });
      save(list);
      authLog(c, 'passkey-registered');
      return c.json({ ok: true });
    } catch (err) {
      authLog(c, 'passkey-register-failed', (err as Error).message);
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // --- Public routes (sign in) -----------------------------------------------------------------

  async function loginOptions(c: Context) {
    if (!load().length) return c.json({ error: 'no passkeys registered yet' }, 404);
    // Discoverable credentials: no allowCredentials, the device offers whatever passkey it has for this site.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    rememberChallenge(c, options.challenge, 'login');
    return c.json(options);
  }

  async function loginVerify(c: Context) {
    if (tooManyFailures()) return c.json({ error: 'too many attempts; try again in a few minutes' }, 429);
    const expectedChallenge = takeChallenge(c, 'login');
    if (!expectedChallenge) return c.json({ error: 'sign-in expired; try again' }, 400);
    const response = await readJson<AuthenticationResponseJSON>(c);
    const list = load();
    const stored = list.find((p) => p.id === response.id);
    if (!stored) {
      noteFailure();
      return c.json({ error: 'unknown passkey; sign in with the token link and add Face ID again' }, 401);
    }
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: stored.id, publicKey: toBytes(stored.publicKey), counter: stored.counter, transports: stored.transports },
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error('passkey not verified');
      stored.counter = result.authenticationInfo.newCounter;
      stored.lastUsedAt = new Date().toISOString();
      save(list);
      issueSession(c);
      authLog(c, 'passkey-login-ok', stored.label);
      return c.json({ ok: true });
    } catch (err) {
      noteFailure();
      authLog(c, 'passkey-login-failed', (err as Error).message);
      return c.json({ error: (err as Error).message }, 401);
    }
  }

  return { listPasskeys, deletePasskey, registrationOptions, registrationVerify, loginOptions, loginVerify };
}
