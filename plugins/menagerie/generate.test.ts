import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CastStore } from './castStore.ts';
import { fixtureCharacter } from './fixtures.ts';
import { createGenerator, type AskFn, type StartJobFn } from './generate.ts';
import { buildPrompt } from './prompt.ts';

/** A model answer for the fixture's look, as SVG text with rig marks. */
const PORTRAIT_SVG =
  '<rect width="64" height="64" fill="#1d3557"/><circle cx="32" cy="28" r="12" fill="#f1c27d"/>' +
  '<g class="brows"><path d="M24 23 Q27 22 30 23" stroke="#333" fill="none"/></g>' +
  '<g class="eyes"><circle cx="27" cy="27" r="1.6" fill="#111"/><circle cx="37" cy="27" r="1.6" fill="#111"/></g>' +
  '<g class="mouth"><g class="mouth-rest"><path d="M29 38 Q32 40 35 38" stroke="#111" fill="none"/></g>' +
  '<g class="mouth-smile"><path d="M28 38 Q32 42 36 38" stroke="#111" fill="none"/></g>' +
  '<g class="mouth-o"><ellipse cx="32" cy="39" rx="1.3" ry="1.5" fill="#111"/></g></g>';

const answer = (over: Record<string, unknown> = {}) => {
  const c = fixtureCharacter();
  return {
    name: 'Captain Beacon',
    emoji: '🗼',
    voice: c.voice,
    color: c.color,
    palette: c.palette,
    mode: c.mode,
    asks: c.asks,
    spinner: c.spinner,
    portrait: { svg: PORTRAIT_SVG },
    motion: { exit: c.motion.exit },
    ...over,
  };
};

interface Harness {
  store: CastStore;
  prompts: string[];
  jobs: { title: string; done: Promise<unknown>; detail?: string | null; error?: string }[];
  gen: ReturnType<typeof createGenerator>;
  release: () => void;
}

/** A generator over a temp store with a scripted model: each call takes the next answer (or throws it). */
async function harness(answers: unknown[], opts: { gate?: boolean } = {}): Promise<Harness> {
  const store = new CastStore(join(await mkdtemp(join(tmpdir(), 'gen-')), 'cast.json'));
  const prompts: string[] = [];
  let open: () => void = () => {};
  let gate = opts.gate ? new Promise<void>((r) => (open = r)) : Promise.resolve();
  const ask: AskFn = async (prompt) => {
    prompts.push(prompt);
    await gate;
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { value: next, costUsd: 0.5, durationMs: 1 };
  };
  const jobs: Harness['jobs'] = [];
  const startJob: StartJobFn = (init, run) => {
    const job = { title: init.title, done: Promise.resolve() as Promise<unknown>, detail: null as string | null, error: undefined as string | undefined };
    job.done = run(() => {}, { payload: init.payload ?? null, setPayload: () => {} }).then(
      (r) => void (job.detail = (r && r.detail) ?? null),
      (e: Error) => void (job.error = e.message),
    );
    jobs.push(job);
    return { id: `job-${jobs.length}` } as never;
  };
  const gen = createGenerator({ ask, store, model: () => 'opus', startJob });
  return { store, prompts, jobs, gen, release: () => { open(); gate = Promise.resolve(); } };
}

test('add: a good answer is stored with the server-chosen id and origin', async () => {
  const h = await harness([answer()]);
  h.gen.add('a lighthouse keeper', 'inspired');
  await h.jobs[0].done;
  const [c] = (await h.store.read()).characters;
  assert.equal(c.id, 'captain-beacon');
  assert.deepEqual(c.origin, { named: 'a lighthouse keeper', kind: 'inspired' });
  assert.ok(c.updatedAt > 0);
  assert.match(h.jobs[0].detail ?? '', /\$0\.50/);
});

test('add: a bad answer then a good one is stored, and the retry quotes the errors', async () => {
  const h = await harness([answer({ color: 'red' }), answer()]);
  h.gen.add('x', 'play');
  await h.jobs[0].done;
  assert.equal((await h.store.read()).characters.length, 1);
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1], /color/);
});

test('add: bad twice fails the job and stores nothing', async () => {
  const h = await harness([answer({ color: 'red' }), answer({ mode: 'spin' })]);
  h.gen.add('x', 'play');
  await h.jobs[0].done;
  assert.match(h.jobs[0].error ?? '', /mode/);
  assert.deepEqual((await h.store.read()).characters, []);
});

test('add: unparsable output counts as bad output', async () => {
  const h = await harness([new SyntaxError('Unexpected token'), answer()]);
  h.gen.add('x', 'play');
  await h.jobs[0].done;
  assert.equal((await h.store.read()).characters.length, 1);
});

test('add: a decline fails at once, after one call', async () => {
  const h = await harness([{ declined: 'not comfortable' }, answer()]);
  h.gen.add('someone', 'play');
  await h.jobs[0].done;
  assert.equal(h.jobs[0].error, 'declined: not comfortable');
  assert.equal(h.prompts.length, 1);
});

test('add: a generated portrait needs brows and a mouth', async () => {
  const noMouth = PORTRAIT_SVG.replace(/<g class="mouth">.*$/, '');
  const h = await harness([answer({ portrait: { svg: noMouth } }), answer({ portrait: { svg: noMouth } })]);
  h.gen.add('x', 'play');
  await h.jobs[0].done;
  assert.match(h.jobs[0].error ?? '', /mouth/);
});

test('add: generated characters need the full set of lines', async () => {
  const h = await harness([answer({ asks: ['One?'] }), answer({ asks: ['One?'] })]);
  h.gen.add('x', 'play');
  await h.jobs[0].done;
  assert.match(h.jobs[0].error ?? '', /asks/);
});

test('add: an emoji already in the cast is bad output (Review Focus 4)', async () => {
  const h = await harness([answer({ emoji: '🐙' }), answer({ emoji: '🗼' })]);
  await h.store.put(fixtureCharacter({ id: 'octo', emoji: '🐙' }));
  h.gen.add('x', 'play');
  await h.jobs[0].done;
  const ids = (await h.store.read()).characters.map((c) => c.emoji);
  assert.deepEqual(ids, ['🐙', '🗼']);
  assert.match(h.prompts[1], /emoji/);
});

test('regenerate lines keeps the look, the identity, and saves previous', async () => {
  const h = await harness([answer({ name: 'Other', emoji: '🐳', color: '#000000', voice: 'A new voice entirely, very grumpy.', asks: ['A?', 'B?', 'C?', 'D?'] })]);
  const before = fixtureCharacter();
  await h.store.put(before);
  const r = await h.gen.regenerate('zed', 'lines', 'grumpier');
  assert.ok('jobId' in r);
  await h.jobs[0].done;
  const [c] = (await h.store.read()).characters;
  assert.equal(c.voice, 'A new voice entirely, very grumpy.');
  assert.deepEqual(c.asks, ['A?', 'B?', 'C?', 'D?']);
  assert.equal(c.name, before.name);
  assert.equal(c.emoji, before.emoji);
  assert.equal(c.color, before.color);
  assert.deepEqual(c.portrait, before.portrait);
  assert.deepEqual(c.motion, before.motion);
  assert.equal(c.previous?.voice, before.voice);
  assert.match(h.prompts[0], /grumpier/);
});

test('regenerate portrait replaces the look (portrait, colours, palette, mode) only', async () => {
  const h = await harness([answer({ color: '#123456', mode: 'fade', voice: 'ignored voice here' })]);
  const before = fixtureCharacter();
  await h.store.put(before);
  await h.gen.regenerate('zed', 'portrait');
  await h.jobs[0].done;
  const [c] = (await h.store.read()).characters;
  assert.equal(c.color, '#123456');
  assert.equal(c.mode, 'fade');
  assert.equal(c.voice, before.voice);
  assert.deepEqual(c.motion, before.motion);
});

test('regenerate all: play keeps the name; inspired may rename; emoji and id never change', async () => {
  const h = await harness([answer({ name: 'New Name', emoji: '🐳' }), answer({ name: 'New Name', emoji: '🐳' })]);
  await h.store.put(fixtureCharacter({ origin: { named: 'Zed', kind: 'play' } }));
  await h.store.put(fixtureCharacter({ id: 'insp', emoji: '🎺', origin: { named: 'jazz', kind: 'inspired' } }));
  await h.gen.regenerate('zed', 'all');
  await h.gen.regenerate('insp', 'all');
  await Promise.all(h.jobs.map((j) => j.done));
  const [zed, insp] = (await h.store.read()).characters;
  assert.equal(zed.name, 'Zed the Lighthouse Keeper');
  assert.equal(zed.emoji, '🗼');
  assert.equal(insp.name, 'New Name');
  assert.equal(insp.emoji, '🎺');
  assert.equal(insp.id, 'insp');
});

test('regenerate: unknown id, and busy while a job for it runs (Review Focus 3)', async () => {
  const h = await harness([answer(), answer()], { gate: true });
  await h.store.put(fixtureCharacter());
  assert.deepEqual(await h.gen.regenerate('nobody', 'lines'), { error: 'unknown' });
  assert.ok('jobId' in (await h.gen.regenerate('zed', 'lines')));
  assert.deepEqual(await h.gen.regenerate('zed', 'motion'), { error: 'busy' });
  h.release();
  await h.jobs[0].done;
  assert.ok('jobId' in (await h.gen.regenerate('zed', 'motion')));
});

test('at most two generations run at once; the third waits', async () => {
  const h = await harness([answer({ name: 'A', emoji: '🅰️' }), answer({ name: 'B', emoji: '🅱️' }), answer({ name: 'C', emoji: '🌊' })], { gate: true });
  h.gen.add('a', 'play');
  h.gen.add('b', 'play');
  h.gen.add('c', 'play');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.prompts.length, 2);
  h.release();
  await Promise.all(h.jobs.map((j) => j.done));
  assert.equal(h.prompts.length, 3);
  assert.equal((await h.store.read()).characters.length, 3);
});

test('pending lists running and queued generations; finished ones drop off', async () => {
  const h = await harness([answer()], { gate: true });
  const { jobId } = h.gen.add('a lighthouse keeper', 'inspired');
  assert.deepEqual(h.gen.pending(), [{ jobId, named: 'a lighthouse keeper', kind: 'inspired', part: 'all' }]);
  h.release();
  await h.jobs[0].done;
  assert.deepEqual(h.gen.pending(), []);
});

test('buildPrompt carries the rules, the other emoji and the feedback', () => {
  const p = buildPrompt({ named: 'Ron Burgundy', kind: 'play', part: 'all', feedback: 'more moustache' }, [fixtureCharacter()]);
  for (const s of ['never quote', 'not a likeness', 'affectionate parody', 'no political attacks', 'private individuals', '"declined"', '🗼', 'more moustache', 'class="eyes"', 'mouth-smile', 'prop1', '"exit"'])
    assert.ok(p.includes(s), s);
});

test('buildPrompt for a partial regenerate names the kept parts and asks only for the replaced keys', () => {
  const c = fixtureCharacter();
  const p = buildPrompt({ named: c.origin.named, kind: c.origin.kind, part: 'motion', id: c.id }, [c], c);
  assert.ok(p.includes(c.name));
  assert.ok(p.includes('"motion"'));
  assert.ok(!p.includes('"asks": ['));
});

test('a reroll that finishes after the character was removed fails and does not bring it back (review I1)', async () => {
  const h = await harness([answer()], { gate: true });
  await h.store.put(fixtureCharacter());
  await h.gen.regenerate('zed', 'lines');
  assert.equal(h.gen.isBusy('zed'), true);
  await h.store.remove('zed');
  h.release();
  await h.jobs[0].done;
  assert.match(h.jobs[0].error ?? '', /removed/);
  assert.deepEqual((await h.store.read()).characters, []);
  assert.equal(h.gen.isBusy('zed'), false);
});
