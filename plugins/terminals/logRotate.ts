/**
 * One generation of log rotation for termd.log: over `maxBytes`, the log is copied to `<file>.1` (replacing the older
 * one) and emptied in place. Copy-and-truncate rather than rename, because a running daemon (or launchd) holds the log
 * open in append mode: after a rename it would keep writing into `.1`, while after a truncate its next write lands at the
 * start of the same file. Standalone (no app imports), like termd.ts, which calls it at start and then, through
 * `logRotator`, from its 10-second save timer (at most once an hour).
 */
import { chmodSync, copyFileSync, statSync, truncateSync } from 'node:fs';

export const TERMD_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** While the daemon runs, rotate at most this often. */
export const TERMD_LOG_ROTATE_INTERVAL_MS = 60 * 60 * 1000;

/** Rotate `file` if it is larger than `maxBytes`; true when it did. A missing file, or any error, does nothing. */
export function rotateLog(file: string, maxBytes: number = TERMD_LOG_MAX_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    copyFileSync(file, `${file}.1`);
    chmodSync(`${file}.1`, 0o600);
    truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a running daemon should rotate now: the log is over `maxBytes` and the last rotation (`lastRotatedAt`, epoch
 * ms; undefined = none yet) was at least `intervalMs` ago.
 */
export function rotationDue(
  sizeBytes: number,
  lastRotatedAt: number | undefined,
  now: number,
  maxBytes: number = TERMD_LOG_MAX_BYTES,
  intervalMs: number = TERMD_LOG_ROTATE_INTERVAL_MS,
): boolean {
  if (sizeBytes <= maxBytes) return false;
  return lastRotatedAt === undefined || now - lastRotatedAt >= intervalMs;
}

/**
 * A tick for the daemon's timer: rotates `file` when `rotationDue`. `rotatedAt` seeds the last rotation (the start-time
 * one). Returns true when it rotated; a missing file or any error does nothing.
 */
export function logRotator(
  file: string,
  opts: { rotatedAt?: number; maxBytes?: number; intervalMs?: number; now?: () => number } = {},
): () => boolean {
  let last = opts.rotatedAt;
  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? TERMD_LOG_MAX_BYTES;
  return () => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return false;
    }
    const t = now();
    if (!rotationDue(size, last, t, maxBytes, opts.intervalMs)) return false;
    if (!rotateLog(file, maxBytes)) return false;
    last = t;
    return true;
  };
}
