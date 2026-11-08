import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const msg = (text: string): void => {
  $('msg').textContent = text;
};

async function postJson(path: string, body: unknown = {}): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function errorOf(r: Response): Promise<string> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `HTTP ${r.status}`;
}

async function tokenLogin(token: string): Promise<void> {
  const r = await postJson('/login', { token });
  if (!r.ok) return msg(await errorOf(r));
  // Freshly signed in with the token: offer to set up a passkey for next time.
  location.replace(browserSupportsWebAuthn() ? '/?offerPasskey=1' : '/');
}

async function pairLogin(code: string): Promise<void> {
  const r = await postJson('/login/pair', { code });
  if (!r.ok) return msg(await errorOf(r));
  location.replace(browserSupportsWebAuthn() ? '/?offerPasskey=1' : '/');
}

async function passkeyLogin(): Promise<void> {
  msg('');
  const opts = await postJson('/login/passkey/options');
  if (!opts.ok) return msg(await errorOf(opts));
  let response;
  try {
    response = await startAuthentication({ optionsJSON: await opts.json() });
  } catch (e) {
    return msg((e as Error).name === 'NotAllowedError' ? 'Cancelled' : (e as Error).message);
  }
  const r = await postJson('/login/passkey/verify', response);
  if (!r.ok) return msg(await errorOf(r));
  location.replace('/');
}

// A link ending in #t=<token> (scripts/setup-auth.sh) or #p=<pairing code> (the QR code from
// "Sign in another device") signs in straight away. The fragment never reaches the server; drop
// it from history right away.
const t = location.hash.match(/[#&]t=([^&]+)/);
const p = location.hash.match(/[#&]p=([^&]+)/);
if (t || p) history.replaceState(null, '', location.pathname);
if (t) void tokenLogin(decodeURIComponent(t[1]));
else if (p) void pairLogin(decodeURIComponent(p[1]));

if (browserSupportsWebAuthn()) {
  $('passkey').hidden = false;
  $('passkey').onclick = () => void passkeyLogin();
} else {
  ($('token-box') as HTMLDetailsElement).open = true;
}

$('token-form').onsubmit = (e) => {
  e.preventDefault();
  void tokenLogin(($('token') as HTMLInputElement).value);
};
