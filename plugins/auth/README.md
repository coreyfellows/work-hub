# auth: sign-in for LAN access

Off by default. work-hub starts in **localhost mode**: no hostname set, node bound to 127.0.0.1, and no sign-in at all.
That is safe only because nothing off this machine can reach it (though every process and macOS account on it can). Turn this plugin on when you serve the app on a
hostname other devices reach (`WORK_HUB_HOSTNAME`, usually through `scripts/setup-lan.sh`). The server refuses to start
with a hostname set and this plugin off:

```
WORK_HUB_HOSTNAME is set but the auth plugin is off: enable it in plugins.json or unset the hostname
```

## What the core guard does either way (server/guard.ts, not this plugin)

The API can type into terminals running Claude with tool access, so it is effectively remote code execution.

- Node binds to 127.0.0.1 only. Other devices reach it only through a TLS front (Caddy, from `scripts/setup-lan.sh`).
- In localhost mode a request carrying `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `X-Real-IP` or
  `CF-Connecting-IP` gets 403 ("proxied request in localhost mode; set WORK_HUB_HOSTNAME and enable the auth plugin"): a
  tunnel or reverse proxy that rewrites Host would otherwise put the unauthenticated app on the network. With a hostname
  those headers are normal (the TLS front adds them).
- In localhost mode a GET to `/api/*` from another site (`Sec-Fetch-Site` present and not `same-origin`/`none`) gets 403.
- `Host` must be one the app answers on: `127.0.0.1:<port>` / `localhost:<port>` in localhost mode (plus the Vite dev
  port when `WORK_HUB_DEV=1`, as `pnpm dev` sets), else only the hostname. Raw IPs, other names and DNS rebinding get 403.
- Writes must be JSON with no `Origin` or an accepted one (CSRF). WebSocket routes check `Origin` themselves with
  `isAcceptedOrigin` (plugin-api/server.ts), since browsers skip CORS there.
- Signing in is delegated to the auth provider this plugin sets (`ctx.auth.setProvider`). Without one, everything that
  passes the checks above is allowed.

## What this plugin adds

- **The cookie.** Every request except the public paths (`/login`, `/login/*`, `/assets/*`, `/ca.pem`) needs `wh_auth`
  (HttpOnly, Secure, SameSite=Strict, `sessionDays`, default 7), the sha256 of `work-hub-cookie:` + the token. API calls
  without it get 401 (the web app then goes to `/login`), pages redirect to `/login`. Rotating the token signs every
  device out. The cookie is always `Secure`, so with this plugin on but no hostname (plain http://127.0.0.1) Safari
  drops it and sign-in loops; use it with a hostname, which is what it's for.
- **The token** in `tokenFile` (default `<state>/token`, 0600 in the 0700 state dir), created at startup if missing.
  An existing token file that is empty or shorter than 16 characters is **not** replaced: `register()` throws, the plugin
  is skipped and, with a hostname set, the server refuses to start (fail closed; an empty token would make the cookie a
  public constant). Delete the file or run `scripts/setup-auth.sh --apply --rotate`. An empty token in `POST /login` is
  always refused. `setup-auth.sh` reads `settings.auth.tokenFile` from plugins.json (jq) so it writes where the server reads.
  `scripts/setup-auth.sh --apply --hostname <name>` creates it too and copies the one-tap link
  `https://<host>/login#t=<token>` to the clipboard (never printed; the fragment never reaches the server and the
  login page drops it). `--rotate` replaces it.
- **Pairing.** Settings → Other devices shows a QR code with a single-use link that expires in 5 minutes.
- **Passkeys** (WebAuthn: Face ID, Touch ID, a screen lock). After a token or pairing sign-in the app offers to add one
  (the `app-banner` slot); Settings → Passkeys lists and removes them. Public keys only, in `passkeys.json` next to the
  token. The RP ID is the hostname, so **changing the hostname orphans every passkey** (sign in with the token again and
  re-add them). Without a hostname there are no passkeys (WebAuthn refuses IP addresses): token and pairing still work.
  Passkeys also refuse sites with certificate warnings, so every device must trust the mkcert root CA.
- **The brake.** Failed token, pairing and passkey sign-ins are counted together: 10 within 10 minutes and further
  attempts get 429. Global (single-user app), kept in SQLite (the core's `auth_failures` table) so a restart can't reset it.
- **`/ca.pem`**: the mkcert root CA *certificate* (`caCertFile`; never served if the file contains a private key), so a
  phone can install it. `scripts/trust-ca-mac.sh` trusts it on the Mac, `scripts/share-ca.sh` puts it in Downloads for AirDrop.
- **`/auth-check`** (204 when signed in): what Caddy's `forward_auth` asks before serving `/notes` and `/code`.
- **The certificate check.** `GET /api/plugins/auth/status` → `{ hostname, certDays, certFile, certError? }` for
  `<tlsDir>/<hostname>.pem`; the same data is the `auth` source (local, hourly, on the SSE stream). It feeds a
  `health-issues` warning when the certificate is missing or has 14 days or less, and the Status page's Sign-in block.
- **The sign-in page** `login.html` + `login.ts`, a second Vite entry (`"webEntries": { "login": "login.html" }` in
  plugin.json; built to `dist/plugin-entries/login.html` while the plugin is on, served at `GET /login`).

## Routes

| route | what |
| --- | --- |
| `GET /login` | the sign-in page (public) |
| `POST /login` `{ token }` | token sign-in (public, braked) |
| `POST /login/pair` `{ code }` | redeem a pairing code (public, braked) |
| `POST /login/passkey/options`, `POST /login/passkey/verify` | passkey sign-in (public, braked) |
| `GET /ca.pem` | the root CA certificate (public) |
| `GET /auth-check` | 204 when signed in |
| `POST /api/pair` | a pairing code `{ code, expiresAt }` |
| `POST /api/logout` | clear the cookie |
| `GET /api/passkeys`, `POST /api/passkeys/delete` `{ id }` | list / remove passkeys |
| `POST /api/passkeys/register/options`, `POST /api/passkeys/register/verify` | add a passkey on this device |
| `GET /api/plugins/auth/status` | hostname and certificate days left |

## Slots

`settings-section` (Passkeys 10 and Other devices 50 on the plugin's own settings page; Sign out 1000, `scope: 'app'`, on the main Settings page), `app-banner` (the passkey offer), `health-issues`
(the certificate), `status-block` (Sign-in, 25).

## Settings

`ctx.config.get` → `WORK_HUB_AUTH_<KEY>` env or plugins.json `settings.auth.<key>`. The old env names still work.

| key | default | old env |
| --- | --- | --- |
| `tokenFile` | `<state>/token` | `WORK_HUB_TOKEN_FILE` |
| `caCertFile` | mkcert's `rootCA.pem` (`mkcert -CAROOT`: `~/Library/Application Support/mkcert` on macOS, `~/.local/share/mkcert` on Linux, `%LOCALAPPDATA%\mkcert` on Windows; `CAROOT` overrides) | `WORK_HUB_CA_CERT` |
| `tlsDir` | `<state>/tls` (where `setup-lan.sh` puts the certificate) | `WORK_HUB_TLS_DIR` |
| `sessionDays` | 7 | `WORK_HUB_SESSION_DAYS` |

## Turning on LAN access

1. `scripts/setup-lan.sh --hostname <name>` (dry run), then `--apply`: turns this plugin on in `plugins.json` if it's
   off, then launchd agents for node (with `WORK_HUB_HOSTNAME`) and Caddy, an mkcert certificate (a valid existing one
   is reused), the Caddyfile; the notes, code and terminal agents when those plugins want them.
2. At the end it runs `scripts/setup-auth.sh --apply`: the first sign-in link on the clipboard (`--no-link` to skip;
   run `scripts/setup-auth.sh --apply --hostname <name>` any time for another).
3. On every device: trust the root CA (`/ca.pem`, `scripts/trust-ca-mac.sh`, `scripts/share-ca.sh`). Firefox on Android
   also needs Settings → About Firefox → tap the logo 5× → back → Secret Settings → Use third party CA certificates.

Keep all of this when adding routes or changing the server: a route a plugin adds sits behind the same guard.
