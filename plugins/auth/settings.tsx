import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import { ago, get, post } from '../../plugin-api/web.ts';

/** The auth plugin's Settings sections (Passkeys, Other devices, Sign out) and the passkey offer after a token sign-in. */

interface PasskeyInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

async function addPasskey(): Promise<void> {
  const options = await post('/api/passkeys/register/options');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await startRegistration({ optionsJSON: options as any });
  await post('/api/passkeys/register/verify', response);
}

function describe(e: unknown): string {
  const err = e as Error;
  if (err.name === 'NotAllowedError') return 'Cancelled';
  if (err.name === 'InvalidStateError') return 'This device already has a passkey for work-hub';
  return err.message;
}

/** Banner shown right after a token sign-in, offering a passkey for next time. */
export function PasskeyOffer() {
  const [show, setShow] = useState(() => new URLSearchParams(location.search).has('offerPasskey') && browserSupportsWebAuthn());
  const [msg, setMsg] = useState<string | null>(null);

  const dismiss = () => {
    history.replaceState(null, '', '/');
    setShow(false);
  };

  if (!show) return null;
  return (
    <div className="offer">
      <span className="grow">Sign in with a passkey next time? (fingerprint, face or screen lock)</span>
      {msg && <span className="muted">{msg}</span>}
      <button
        onClick={async () => {
          try {
            await addPasskey();
            setMsg('Added');
            setTimeout(dismiss, 1200);
          } catch (e) {
            setMsg(describe(e));
          }
        }}
      >
        Add passkey
      </button>
      <button className="ghost" onClick={dismiss}>
        Not now
      </button>
    </div>
  );
}

/** Passkeys on file, and adding one on this device. */
export function PasskeysSetting() {
  const [keys, setKeys] = useState<PasskeyInfo[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => get<PasskeyInfo[]>('/api/passkeys').then(setKeys, (e) => setMsg((e as Error).message));
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      {keys.length === 0 && <div className="muted">None yet</div>}
      {keys.map((k) => (
        <div key={k.id} className="menu-row">
          <span className="grow">
            {k.label} <span className="muted">· added {ago(k.createdAt)} ago{k.lastUsedAt ? ` · used ${ago(k.lastUsedAt)} ago` : ''}</span>
          </span>
          <button
            className="small"
            onClick={async () => {
              await post('/api/passkeys/delete', { id: k.id });
              void load();
            }}
          >
            Remove
          </button>
        </div>
      ))}
      {browserSupportsWebAuthn() && (
        <button
          onClick={async () => {
            setMsg(null);
            try {
              await addPasskey();
              setMsg('Added');
              void load();
            } catch (e) {
              setMsg(describe(e));
            }
          }}
        >
          Add a passkey on this device
        </button>
      )}
      {msg && <div className="muted">{msg}</div>}
    </>
  );
}

export function SignOut() {
  return (
    <button
      className="ghost"
      onClick={async () => {
        await post('/api/logout');
        location.href = '/login';
      }}
    >
      Sign out
    </button>
  );
}

/** Shows a QR code with a one-time, 5-minute sign-in link for another device. */
export function PairDevice() {
  const [qr, setQr] = useState<{ url: string; image: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!qr) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [qr]);

  const show = async () => {
    setError(null);
    try {
      const { code, expiresAt } = await post<{ code: string; expiresAt: number }>('/api/pair');
      const url = `${location.origin}/login#p=${code}`;
      setQr({ url, image: await QRCode.toDataURL(url, { margin: 1, width: 240 }), expiresAt });
      setNow(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const left = qr ? Math.max(0, Math.round((qr.expiresAt - now) / 1000)) : 0;
  if (qr && left > 0) {
    return (
      <div className="pair">
        <img src={qr.image} alt="Sign-in QR code" />
        <div className="muted">
          Scan with the other device. Works once; expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
        </div>
        <button className="ghost" onClick={() => setQr(null)}>
          Done
        </button>
      </div>
    );
  }
  return (
    <>
      <button onClick={show}>{qr ? 'Code expired, show a new one' : 'Sign in another device'}</button>
      {error && <div className="bad">{error}</div>}
    </>
  );
}
