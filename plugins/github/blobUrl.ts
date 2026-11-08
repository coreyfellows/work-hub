/**
 * GitHub file links (`https://<host>/<owner>/<repo>/blob/<ref>/<path>#L10-L20`): parsed on both halves, the web one to
 * open them in a modal, the server one to fetch the file at that ref. A ref may hold slashes (`feature/x`), so the
 * segments after `blob/` are kept together and `refSplits` lists the ways to cut them, shortest ref first.
 */

export interface BlobLink {
  host: string;
  owner: string;
  repo: string;
  /** The URL-decoded segments after `blob/`: the ref, then the path. */
  rest: string[];
  /** The line anchor (`#L10`, `#L10-L20`), 1-based and inclusive. */
  lines?: { from: number; to: number };
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function parseBlobUrl(href: string | undefined | null): BlobLink | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const segs = u.pathname.split('/').slice(1);
  if (segs.length < 5 || segs[2] !== 'blob') return null;
  const [owner, repo] = segs;
  if (!NAME_RE.test(owner!) || !NAME_RE.test(repo!)) return null;
  let rest: string[];
  try {
    rest = segs.slice(3).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (rest.some((s) => !s || s === '.' || s === '..' || s.includes('\0'))) return null;
  const m = /^#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/.exec(u.hash);
  const from = m ? Number(m[1]) : 0;
  const to = m?.[2] ? Number(m[2]) : from;
  return { host: u.host.toLowerCase(), owner: owner!, repo: repo!, rest, ...(from > 0 ? { lines: { from: Math.min(from, to), to: Math.max(from, to) } } : {}) };
}

/** The ways to read `rest` as ref + path, shortest ref first (a full commit SHA is never followed by more ref). */
export function refSplits(rest: string[], max = 4): Array<{ ref: string; path: string }> {
  const out: Array<{ ref: string; path: string }> = [];
  for (let i = 1; i < rest.length && out.length < max; i++) {
    out.push({ ref: rest.slice(0, i).join('/'), path: rest.slice(i).join('/') });
    if (i === 1 && /^[0-9a-f]{40}$/i.test(rest[0]!)) break;
  }
  return out;
}

/** Ref and path for a title (the first segment as the ref; a branch with slashes shows part of it in the path). */
export function blobLabel(link: BlobLink): { ref: string; path: string } {
  return { ref: link.rest[0] ?? '', path: link.rest.slice(1).join('/') };
}
