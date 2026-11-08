import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const JSON_BODY_REQUIRED = 'JSON body required';

/**
 * A route's JSON body, which must be a JSON object. An empty, unparsable or non-object body throws an `HTTPException`
 * whose response is `400 { error: 'JSON body required' }` (Hono answers with it, unless a `try` around the call catches
 * it first: rethrow it, or return `err.getResponse()`). Shared by core and plugin routes via plugin-api/server.ts.
 */
export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HTTPException(400, { res: c.json({ error: JSON_BODY_REQUIRED }, 400) });
  }
  return body as T;
}
