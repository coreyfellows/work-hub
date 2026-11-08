import { run } from '../../plugin-api/server.ts';
import { refSplits, type BlobLink } from './blobUrl.ts';
import { settings } from './settings.ts';

/** A file at a ref, as the file modal shows it. */
export interface BlobFile {
  ref: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

const MAX = 1024 * 1024;
const CACHE_MAX = 40;
/** Files at a full commit SHA never change: the last few are kept, so reopening a link costs nothing. */
const cache = new Map<string, BlobFile>();

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Reads the file a blob link points at through `gh api` (the contents API, raw), trying each way to cut the segments
 * into ref + path until one exists. The link must be on the host gh uses: anything else is refused, not fetched.
 */
export async function fetchBlob(link: BlobLink): Promise<BlobFile> {
  const host = await settings().host();
  if (link.host !== host.toLowerCase()) throw new Error(`not a ${host} link`);
  let last: Error | null = null;
  for (const { ref, path } of refSplits(link.rest)) {
    const key = `${link.owner}/${link.repo}@${ref}:${path}`.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      const raw = await run(
        'gh',
        ['api', '--hostname', host, '-H', 'Accept: application/vnd.github.raw', `repos/${link.owner}/${link.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`],
        { timeoutMs: 30_000, cwd: settings().scratch },
      );
      const binary = raw.slice(0, 8000).includes('\0');
      const file: BlobFile = { ref, path, size: Buffer.byteLength(raw), truncated: raw.length > MAX, binary, content: binary ? '' : raw.slice(0, MAX) };
      if (/^[0-9a-f]{40}$/i.test(ref)) {
        cache.set(key, file);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      return file;
    } catch (err) {
      last = err as Error;
      if (!/404|Not Found/i.test(last.message)) break; // only "no such ref/path" is worth another cut
    }
  }
  throw new Error(last ? last.message.replace(/^gh api: /, '') : 'not a file link');
}
