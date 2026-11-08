/**
 * How much a PR changed since its summary was written. At generation the PR's files are snapshotted with a hash of
 * every changed line of their patch; later the current files are compared with that snapshot. Comparing the diffs
 * (not the commits) keeps it right across rebases and force-pushes, and needs no local checkout. Pure.
 */

export interface PrFileLike {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface FileSnap {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Hashes of the patch's `+`/`-` lines (null: binary or too large for GitHub to send a patch). */
  lines: string[] | null;
}

export interface Since {
  /** Files whose diff differs from the snapshot (changed, newly in the PR, or no longer in it). */
  files: number;
  newFiles: string[];
  goneFiles: string[];
  changedFiles: string[];
  /** Diff lines that weren't in the PR's diff before, and ones that no longer are. */
  linesAdded: number;
  linesRemoved: number;
  /** The PR's totals now. */
  now: { files: number; additions: number; deletions: number };
}

/** FNV-1a, 32 bits, hex: plenty to tell diff lines apart, and small in meta.json. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function changeLines(patch: string): string[] {
  return patch
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .map(hash);
}

export function snapFiles(files: PrFileLike[]): FileSnap[] {
  return files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, lines: f.patch == null ? null : changeLines(f.patch) }));
}

/** Lines in `a` not matched one-for-one in `b` (multiset difference). */
function missing(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  let n = 0;
  for (const x of a) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
    else n++;
  }
  return n;
}

export function changesSince(before: FileSnap[], now: FileSnap[]): Since {
  const old = new Map(before.map((f) => [f.path, f]));
  const cur = new Map(now.map((f) => [f.path, f]));
  const out: Since = {
    files: 0,
    newFiles: [],
    goneFiles: [],
    changedFiles: [],
    linesAdded: 0,
    linesRemoved: 0,
    now: { files: now.length, additions: now.reduce((n, f) => n + f.additions, 0), deletions: now.reduce((n, f) => n + f.deletions, 0) },
  };
  for (const f of now) {
    const o = old.get(f.path);
    if (!o) {
      out.newFiles.push(f.path);
      out.linesAdded += f.lines?.length ?? f.additions + f.deletions;
      continue;
    }
    let added: number;
    let removed: number;
    if (f.lines && o.lines) {
      added = missing(f.lines, o.lines);
      removed = missing(o.lines, f.lines);
    } else {
      // No patch on one side: the best we have is how the counts moved.
      const same = f.additions === o.additions && f.deletions === o.deletions && f.status === o.status;
      added = same ? 0 : Math.abs(f.additions - o.additions) + Math.abs(f.deletions - o.deletions) || 1;
      removed = 0;
    }
    if (added || removed || f.status !== o.status) out.changedFiles.push(f.path);
    out.linesAdded += added;
    out.linesRemoved += removed;
  }
  for (const o of before) {
    if (cur.has(o.path)) continue;
    out.goneFiles.push(o.path);
    out.linesRemoved += o.lines?.length ?? o.additions + o.deletions;
  }
  out.files = out.newFiles.length + out.goneFiles.length + out.changedFiles.length;
  return out;
}
