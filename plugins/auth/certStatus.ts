import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthStatus } from './types.ts';

/** The certificate scripts/setup-lan.sh issues for the hostname: `<tlsDir>/<hostname>.pem`. */
export async function certStatus(hostname: string | undefined, tlsDir: string, now = Date.now()): Promise<AuthStatus> {
  if (!hostname) return { hostname: null, certDays: null, certFile: null };
  const certFile = join(tlsDir, `${hostname}.pem`);
  try {
    const cert = new X509Certificate(await readFile(certFile));
    return { hostname, certFile, certDays: Math.floor((Date.parse(cert.validTo) - now) / 86_400_000) };
  } catch (err) {
    return { hostname, certFile, certDays: null, certError: (err as Error).message };
  }
}
