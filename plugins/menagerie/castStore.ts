// The cast file on disk (<pluginState>/cast.json). The server is the only writer: every write goes through the
// validator, then a temp file and a rename, one at a time. Reads are cached by mtime, so an edit by hand or by
// another process shows up. A file that doesn't parse reads as an empty cast and is left alone until the next write.
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateCast, validateCharacter, type CastFile, type Character } from './cast.ts';

export class CastStore {
  readonly path: string;
  private cache: { mtimeMs: number; size: number; cast: CastFile; damaged: boolean } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.path = file;
  }

  async read(): Promise<CastFile> {
    const s = await stat(this.path).catch(() => null);
    if (!s) return { version: 1, characters: [] };
    if (this.cache && this.cache.mtimeMs === s.mtimeMs && this.cache.size === s.size) return this.cache.cast;
    let raw: unknown = null;
    let damaged = false;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (err) {
      damaged = true;
      console.warn(`menagerie: ${this.path} doesn't parse (${(err as Error).message}); reading it as an empty cast`);
    }
    const { cast, dropped } = validateCast(raw);
    for (const d of dropped) console.warn(`menagerie: dropped character ${d.id ?? '?'} from ${this.path}: ${d.errors.join('; ')}`);
    this.cache = { mtimeMs: s.mtimeMs, size: s.size, cast, damaged: damaged || dropped.length > 0 };
    return cast;
  }

  /** Runs `fn` after every earlier write has finished, so read-modify-write never interleaves. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async write(cast: CastFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // A file that didn't parse, or held a character the validator dropped, is kept as it was before it's overwritten,
    // so a hand edit with a typo isn't lost.
    await this.read();
    if (this.cache?.damaged) {
      const backup = `${this.path}.bad-${Date.now()}`;
      await copyFile(this.path, backup);
      console.warn(`menagerie: kept the damaged cast file as ${backup}`);
    }
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cast, null, 1)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
    this.cache = null;
  }

  /**
   * Adds or replaces (by id). `mode`: 'create' fails when the id is taken, 'replace' fails when the character is gone
   * (removed while a reroll ran), 'upsert' (default) does either. `keepPrevious` stores the replaced version for one
   * undo. Throws when invalid.
   */
  put(c: Character, opts: { keepPrevious?: boolean; mode?: 'create' | 'replace' | 'upsert' } = {}): Promise<void> {
    return this.serial(async () => {
      const cast = await this.read();
      const old = cast.characters.find((x) => x.id === c.id);
      if (opts.mode === 'replace' && !old) throw new Error('that character was removed');
      if (opts.mode === 'create' && old) throw new Error(`id "${c.id}" is already in the cast`);
      const others = cast.characters.filter((x) => x.id !== c.id);
      const { previous: _drop, ...oldBare } = old ?? ({} as Character);
      const r = validateCharacter({ ...c, previous: opts.keepPrevious && old ? oldBare : c.previous }, others);
      if (!r.ok) throw new Error(`invalid character: ${r.errors.join('; ')}`);
      const characters = old ? cast.characters.map((x) => (x.id === c.id ? r.value : x)) : [...cast.characters, r.value];
      await this.write({ version: 1, characters });
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const cast = await this.read();
      if (!cast.characters.some((c) => c.id === id)) return false;
      await this.write({ version: 1, characters: cast.characters.filter((c) => c.id !== id) });
      return true;
    });
  }

  /** Restores the version before the last regenerate (and clears it). Null when there's nothing to undo. */
  undo(id: string): Promise<Character | null> {
    return this.serial(async () => {
      const cast = await this.read();
      const c = cast.characters.find((x) => x.id === id);
      if (!c?.previous) return null;
      const restored: Character = { ...c.previous, updatedAt: Date.now() };
      await this.write({ version: 1, characters: cast.characters.map((x) => (x.id === id ? restored : x)) });
      return restored;
    });
  }

  /** Merges into or replaces the cast; every incoming character is validated like a generated one. */
  importCast(raw: unknown, mode: 'replace' | 'merge'): Promise<{ added: string[]; skipped: { id?: string; reason: string }[] }> {
    return this.serial(async () => {
      const incoming = (raw && typeof raw === 'object' && Array.isArray((raw as { characters?: unknown }).characters)
        ? (raw as { characters: unknown[] }).characters
        : []) as unknown[];
      const kept = mode === 'merge' ? [...(await this.read()).characters] : [];
      const added: string[] = [];
      const skipped: { id?: string; reason: string }[] = [];
      for (const c of incoming) {
        const r = validateCharacter(c, kept);
        const id = c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string' ? (c as { id: string }).id : undefined;
        if (!r.ok) skipped.push({ id, reason: r.errors.join('; ') });
        else {
          kept.push(r.value);
          added.push(r.value.id);
        }
      }
      // Replacing the whole cast with a file that has nothing valid in it would only wipe it.
      if (mode === 'replace' && !added.length) throw new Error('no valid characters in that file');
      await this.write({ version: 1, characters: kept });
      return { added, skipped };
    });
  }
}
