import { request } from 'node:http';

/**
 * Is a terminal daemon on this socket? Shared by the plugin (whether to start one) and termd.ts itself (whether it may take
 * the socket path). Standalone (node:http only), because termd.ts imports nothing from the app.
 */

export type ProbeResult = { status: number } | { errorCode: string };

/**
 * Only a missing socket file (ENOENT) or one nobody listens on (ECONNREFUSED: left over by a crash) means "absent". Anything
 * else (a timeout, a bad reply, EACCES…) is taken as "present", so a slow or odd daemon is never replaced while it runs.
 */
export function classifyProbe(r: ProbeResult): 'answered' | 'absent' | 'unclear' {
  if ('status' in r) return r.status === 200 ? 'answered' : 'unclear';
  return r.errorCode === 'ENOENT' || r.errorCode === 'ECONNREFUSED' ? 'absent' : 'unclear';
}

/** One `GET /terms?workspace=` on the socket (default 2s timeout). */
export function probeSocket(socket: string, timeoutMs = 2_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, path: '/terms?workspace=', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('error', () => resolve({ errorCode: 'EBADREPLY' }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ errorCode: (e as NodeJS.ErrnoException).code ?? 'EUNKNOWN' }));
    req.end();
  });
}
