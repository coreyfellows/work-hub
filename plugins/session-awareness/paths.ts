import { normPath } from '../../plugin-api/platform.ts';

/** One spelling for a path from Claude, git or the store (Windows drive/slash forms), without a trailing slash. */
export function cleanPath(p: string): string {
  const n = normPath(p);
  return n.length > 1 && n.endsWith('/') && !/^[A-Za-z]:\/$/.test(n) ? n.replace(/\/+$/, '') : n;
}

/** Whether `p` is `root` or inside it (both through `cleanPath`). */
export function within(p: string, root: string): boolean {
  const a = cleanPath(p);
  const r = cleanPath(root);
  return a === r || a.startsWith(r.endsWith('/') ? r : `${r}/`);
}
