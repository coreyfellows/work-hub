/**
 * The id of the UI build being served (written to dist/build.txt by vite.config.ts and baked into the bundle as
 * `__WH_BUILD__`). Sent on the SSE stream so tabs running an older build reload themselves after a deploy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readBuildId(distDir: string): string | null {
  try {
    return readFileSync(join(distDir, 'build.txt'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
