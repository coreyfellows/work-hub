// Generation jobs: one headless model call per character (or per part of one), at most two at a time, started only
// from a user's request. The answer is parsed, sanitized (svg.ts, keyframes.ts) and validated (cast.ts) before it
// is stored; one retry with the problems listed, then the job fails. A decline fails at once.
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { LIMITS, portraitErrors, slugId, validateCharacter, type Character } from './cast.ts';
import type { CastStore } from './castStore.ts';
import { buildPrompt, PART_KEYS, retryPrompt, type GenRequest, type Part } from './prompt.ts';
import { parseSvg } from './svg.ts';

export type { Part };
export type AskFn = (prompt: string) => Promise<{ value: unknown; costUsd: number | null; durationMs: number | null }>;
export type StartJobFn = ServerPluginContext['jobs']['start'];

export const GEN_JOB_KIND = 'menagerie-generate';
export const MAX_RUNNING = 2;
export const SETTINGS_LINK = { to: '/settings/plugins/menagerie', label: 'See the cast' };

export interface Pending {
  jobId: string;
  named: string;
  kind: 'play' | 'inspired';
  part: Part;
  id?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const PART_LABEL: Record<Part, string> = { all: 'Recreating', lines: 'Rewriting the lines of', portrait: 'Redrawing', motion: 'Reanimating' };

/**
 * Turns a model answer into a character: only the keys the part replaces are taken; identity (id, emoji, origin,
 * createdAt; the name too unless an "inspired" character is recreated) comes from the existing character or the
 * server. Returns the problems when it doesn't hold up.
 */
export function buildCharacter(
  value: unknown,
  req: GenRequest,
  cast: Character[],
  current: Character | undefined,
  now: number,
): { ok: true; value: Character } | { ok: false; errors: string[] } {
  if (!isObj(value)) return { ok: false, errors: ['the answer must be one JSON object'] };
  const keys = PART_KEYS[req.part];
  const errors: string[] = [];
  const picked: Record<string, unknown> = {};
  for (const k of keys) {
    if (value[k] === undefined) {
      if (k !== 'badge') errors.push(`${k}: missing`);
      continue;
    }
    picked[k] = value[k];
  }
  if (keys.includes('portrait') && isObj(picked.portrait)) {
    const svg = picked.portrait.svg;
    const parsed = typeof svg === 'string' ? parseSvg(svg) : ({ ok: false, error: 'portrait.svg must be a string of SVG elements' } as const);
    if (!parsed.ok) errors.push(`portrait: ${parsed.error}`);
    else {
      picked.portrait = { nodes: parsed.nodes, ...(picked.portrait.ampCap !== undefined && { ampCap: picked.portrait.ampCap }) };
      errors.push(...portraitErrors(picked.portrait, { complete: true }));
    }
  } else if (keys.includes('portrait') && picked.portrait !== undefined) errors.push('portrait: must be { "svg": "…" }');
  if (keys.includes('asks') && Array.isArray(picked.asks) && (picked.asks.length < 4 || picked.asks.length > LIMITS.asks.max))
    errors.push('asks: 4–8 lines');
  if (keys.includes('spinner') && Array.isArray(picked.spinner) && (picked.spinner.length < 6 || picked.spinner.length > LIMITS.spinner.max))
    errors.push('spinner: 6–12 entries');
  if (errors.length) return { ok: false, errors };

  const others = cast.filter((c) => c.id !== current?.id);
  const { previous: _p, ...base } = current ?? ({} as Character);
  const merged: Record<string, unknown> = { ...base, ...picked, updatedAt: now };
  if (current) {
    merged.id = current.id;
    merged.emoji = current.emoji;
    merged.origin = current.origin;
    merged.createdAt = current.createdAt;
    if (!(req.part === 'all' && current.origin.kind === 'inspired')) merged.name = current.name;
    if (req.part !== 'all' && req.part !== 'lines' && current.badge === undefined) delete merged.badge;
  } else {
    merged.origin = { named: req.named, kind: req.kind };
    merged.createdAt = now;
    merged.id = typeof merged.name === 'string' ? slugId(merged.name, new Set(cast.map((c) => c.id))) : 'host';
  }
  return validateCharacter(merged, others);
}

export function createGenerator(deps: { ask: AskFn; store: CastStore; model?: () => string; startJob: StartJobFn; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const busy = new Set<string>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = () =>
    running < MAX_RUNNING ? Promise.resolve(void running++) : new Promise<void>((r) => waiting.push(() => r(void running++)));
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  function start(req: GenRequest, title: string): string {
    let jobId = '';
    const job = deps.startJob({ kind: GEN_JOB_KIND, title, payload: req }, async (progress) => {
      if (running >= MAX_RUNNING) progress('Waiting for another character to finish…');
      await slot();
      try {
        return await generate(req, progress);
      } finally {
        release();
        pending.delete(jobId);
        if (req.id) busy.delete(req.id);
      }
    });
    jobId = job.id;
    pending.set(jobId, { jobId, named: req.named, kind: req.kind, part: req.part, ...(req.id && { id: req.id }) });
    return jobId;
  }

  async function generate(req: GenRequest, progress: (d: string) => void) {
    const cast = (await deps.store.read()).characters;
    const current = req.id ? cast.find((c) => c.id === req.id) : undefined;
    if (req.id && !current) throw new Error('that character was removed');
    const prompt = buildPrompt(req, cast, current);
    let errors: string[] = [];
    let cost = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      progress(attempt ? 'Fixing a few things…' : req.part === 'portrait' ? 'Drawing…' : req.part === 'motion' ? 'Animating…' : 'Writing…');
      let value: unknown;
      try {
        const r = await deps.ask(attempt ? retryPrompt(prompt, errors) : prompt);
        cost += r.costUsd ?? 0;
        value = r.value;
      } catch (err) {
        // An answer that isn't JSON is bad output (retry); a CLI or network failure is not.
        if (!(err instanceof SyntaxError)) throw err;
        errors = ['the answer was not valid JSON'];
        continue;
      }
      if (isObj(value) && typeof value.declined === 'string') throw new Error(`declined: ${value.declined.slice(0, 200)}`);
      progress('Checking…');
      const fresh = (await deps.store.read()).characters;
      const built = buildCharacter(value, req, fresh, current, now());
      if (built.ok) {
        await deps.store.put(built.value, current ? { keepPrevious: true, mode: 'replace' } : { mode: 'create' });
        return { detail: `${built.value.name}${deps.model ? ` · ${deps.model()}` : ''} · $${cost.toFixed(2)}`, link: SETTINGS_LINK };
      }
      errors = built.errors;
    }
    throw new Error(errors.join('; '));
  }

  return {
    /** Starts generating a new character. */
    add(named: string, kind: 'play' | 'inspired', feedback?: string): { jobId: string } {
      return { jobId: start({ named, kind, part: 'all', ...(feedback && { feedback }) }, `Creating a host: ${named}`) };
    },
    /** Starts regenerating one part of a character; 'busy' while another job for it runs. */
    async regenerate(id: string, part: Part, feedback?: string): Promise<{ jobId: string } | { error: 'busy' | 'unknown' }> {
      const c = (await deps.store.read()).characters.find((x) => x.id === id);
      if (!c) return { error: 'unknown' };
      if (busy.has(id)) return { error: 'busy' };
      busy.add(id);
      const req: GenRequest = { named: c.origin.named, kind: c.origin.kind, part, id, ...(feedback && { feedback }) };
      try {
        return { jobId: start(req, `${PART_LABEL[part]} ${c.name}`) };
      } catch (err) {
        busy.delete(id);
        throw err;
      }
    },
    /** Whether a regenerate for `id` is running or queued (Remove waits for it). */
    isBusy(id: string): boolean {
      return busy.has(id);
    },
    /** Generations running or queued in this process (the editor's placeholders). */
    pending(): Pending[] {
      return [...pending.values()];
    },
  };
}

export type Generator = ReturnType<typeof createGenerator>;
