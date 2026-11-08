import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { FailureBrake } from './failureBrake.ts';

/**
 * Sign-in. With a hostname set the app is reachable from the LAN (via the TLS front) and can type into Claude
 * terminals, so every request needs a valid session cookie. A device gets one either from the token
 * (scripts/setup-auth.sh copies a one-tap link), a pairing QR code from a signed-in device, or, once it has registered
 * one, a passkey (passkeys.ts). The cookie holds a hash derived from the token, so rotating the token signs every
 * device out.
 */

export const COOKIE = 'wh_auth';

/** Shorter tokens (an empty or truncated token file) are refused: an empty token would make the cookie a public constant. */
export const MIN_TOKEN_LENGTH = 16;

export function tooShortMessage(file: string): string {
  return `the sign-in token in ${file} is empty or shorter than ${MIN_TOKEN_LENGTH} characters: delete it (the server makes a new one) or run scripts/setup-auth.sh --apply --rotate`;
}

/**
 * Read the token, creating it (0600, in a 0700 folder) if it isn't there yet. An existing token that is too short
 * throws instead of being replaced (fail closed: with a hostname the plugin is skipped and the server refuses to start).
 */
export function loadOrCreateToken(file: string): string {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(24).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  }
  chmodSync(file, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(tooShortMessage(file));
  return token;
}

/** The cookie value a token signs in with (sha256 of "work-hub-cookie:" + token, base64url). */
export function cookieFor(token: string): string {
  return createHash('sha256').update(`work-hub-cookie:${token}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** One line per sign-in event, for debugging device setup. Never logs secrets. */
export function authLog(c: Context, event: string, detail = ''): void {
  const ua = c.req.header('user-agent') ?? '';
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : 'other';
  console.log(`[auth] ${new Date().toISOString()} ${event} device=${device}${detail ? ` ${detail}` : ''}`);
}

export interface Auth {
  isAuthed(c: Context): boolean;
  issueSession(c: Context): void;
  /** Brute-force brake shared by token, pairing and passkey sign-in. */
  tooManyFailures(): boolean;
  noteFailure(): void;
  handleLogin(c: Context): Promise<Response>;
  createPairing(c: Context): Response;
  redeemPairing(c: Context): Promise<Response>;
  handleLogout(c: Context): Response;
}

export function createAuth(o: { token: string; sessionDays: number; brake: FailureBrake }): Auth {
  const { token, brake } = o;
  if (token.trim().length < MIN_TOKEN_LENGTH) throw new Error(`sign-in token shorter than ${MIN_TOKEN_LENGTH} characters`);
  const cookieValue = cookieFor(token);
  const tooManyFailures = () => brake.tooMany();
  const noteFailure = () => brake.note();

  const issueSession = (c: Context) =>
    setCookie(c, COOKIE, cookieValue, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: o.sessionDays * 24 * 3600 });

  // --- Pairing: a signed-in device shows a QR code that signs another device in once -------------
  const PAIR_TTL_MS = 5 * 60_000;
  const pairings = new Map<string, number>(); // code -> expiry

  return {
    isAuthed(c) {
      const v = getCookie(c, COOKIE);
      return !!v && safeEqual(v, cookieValue);
    },
    issueSession,
    tooManyFailures,
    noteFailure,

    async handleLogin(c) {
      if (tooManyFailures()) return c.json({ error: 'too many attempts; try again in a few minutes' }, 429);
      const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
      const given = typeof body.token === 'string' ? body.token.trim() : '';
      if (!given || !safeEqual(given, token)) {
        noteFailure();
        authLog(c, 'token-login-failed');
        return c.json({ error: 'wrong token' }, 401);
      }
      issueSession(c);
      authLog(c, 'token-login-ok');
      return c.json({ ok: true });
    },

    /** Signed in: mint a single-use code that expires in 5 minutes. */
    createPairing(c) {
      const now = Date.now();
      for (const [k, exp] of pairings) if (exp < now) pairings.delete(k);
      const code = randomBytes(18).toString('base64url');
      pairings.set(code, now + PAIR_TTL_MS);
      authLog(c, 'pairing-created');
      return c.json({ code, expiresAt: now + PAIR_TTL_MS });
    },

    /** Public: redeem a pairing code for a session. */
    async redeemPairing(c) {
      if (tooManyFailures()) return c.json({ error: 'too many attempts; try again in a few minutes' }, 429);
      const { code } = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
      const exp = typeof code === 'string' ? pairings.get(code) : undefined;
      if (typeof code === 'string') pairings.delete(code); // single use, even on expiry
      if (!exp || exp < Date.now()) {
        noteFailure();
        authLog(c, 'pairing-failed');
        return c.json({ error: 'that code has expired or was already used; show a new QR code' }, 401);
      }
      issueSession(c);
      authLog(c, 'pairing-ok');
      return c.json({ ok: true });
    },

    handleLogout(c) {
      deleteCookie(c, COOKIE, { path: '/', secure: true });
      return c.json({ ok: true });
    },
  };
}
