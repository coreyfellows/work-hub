/** `GET /api/plugins/auth/status` and the `auth` source's data. */
export interface AuthStatus {
  /** The configured hostname (`WORK_HUB_HOSTNAME`), or null in localhost mode. */
  hostname: string | null;
  /** Whole days until the hostname's TLS certificate (`<tlsDir>/<hostname>.pem`) expires; null if it can't be read. */
  certDays: number | null;
  certFile: string | null;
  /** Why the certificate couldn't be read. */
  certError?: string;
}
