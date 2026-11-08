import { execFile } from 'node:child_process';

/** The first host in `gh auth status` output (`✓ Logged in to <host> account …`), else undefined. */
export function parseGhAuthHost(output: string): string | undefined {
  return /Logged in to (\S+)/.exec(output)?.[1];
}

/**
 * The first GitHub host `gh` is signed in to, asked afresh on every call. Both streams are read whatever the exit code:
 * `gh auth status` exits 1 when any one of several hosts has a bad token, but still lists the good ones (older
 * versions print to stderr). Undefined when gh is missing, signed in nowhere, or can't tell yet (e.g. no network).
 */
export function ghAuthStatusHost(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 15_000 }, (_err, stdout, stderr) => {
      resolve(parseGhAuthHost(`${stdout ?? ''}\n${stderr ?? ''}`));
    });
  });
}

export const FALLBACK_HOST = 'github.com';

/**
 * The host every `gh` call goes to, resolved lazily (on the first fetch or route, never while the server starts). A
 * configured host is the fast path. Otherwise `lookup` (`gh auth status`) is asked, one call at a time; only a host it
 * actually found is kept. When it finds none, that call uses `github.com` and the next call asks again, so a lookup
 * made before the network or gh was ready doesn't stick for the life of the process.
 */
export function hostResolver(configured: string | undefined, lookup: () => Promise<string | undefined> = ghAuthStatusHost): () => Promise<string> {
  if (configured) return () => Promise.resolve(configured);
  let found: string | undefined;
  let pending: Promise<string | undefined> | null = null;
  return async () => {
    if (found) return found;
    pending ??= lookup()
      .catch(() => undefined)
      .finally(() => {
        pending = null;
      });
    found = (await pending) ?? found;
    return found ?? FALLBACK_HOST;
  };
}
