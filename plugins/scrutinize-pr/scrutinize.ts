import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { addUpdateNote, applyAddendum, applyEdits, applyRewrite, findSection, splitSections } from './doc.ts';
import { askPrompt, GIT_TOOLS, inlineDiff, parseAnswer, parseUpdate, summaryPrompt, updatePrompt, type CodeAccess, type PrFacts, type UpdateAnswer } from './prompts.ts';
import { changesSince, snapFiles, type Since } from './since.ts';
import { keyId, type PrKey, type SummaryStore } from './store.ts';
import type { SummaryView, Thread } from './types.ts';

/**
 * Writing a PR's summary and answering questions about it. Both are headless `claude -p` runs owned by a server job
 * (never sessions): named `wh-scrutinize:…` so the sessions list hides them, with no session persistence and no MCP.
 * Everything outside (the github service, running commands, where things are) comes in as `ScrutinizeDeps`, so tests
 * drive it with fakes.
 */

export const RUN_PREFIX = 'wh-scrutinize:';

/** What this plugin uses of the github plugin's `github` service (its `GithubService`; plugins don't import each other). */
export interface GithubLike {
  host(): Promise<string>;
  parseRef(owner: string, name: string, number: string): { owner: string; name: string; number: number } | null;
  prDetail(owner: string, name: string, number: number): Promise<{
    url: string;
    title: string;
    body: string;
    author: string;
    base: string;
    head: string;
    headOid: string;
  }>;
  prFiles(owner: string, name: string, number: number): Promise<Array<{ path: string; previousPath: string | null; status: string; additions: number; deletions: number; patch: string | null }>>;
}

export interface ScrutinizeDeps {
  store: SummaryStore;
  /** The github service, or undefined while that plugin is off (looked up on each use). */
  github(): GithubLike | undefined;
  run(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string }): Promise<string>;
  /** Where repos are cloned (`<reposDir>/<repo name>`). */
  reposDir: string;
  /** A neutral folder for runs without a clone. */
  scratchDir: string;
  model(): string;
  timeoutMs?: { summary: number; answer: number };
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const QUESTION_MAX = 4000;
const QUOTE_MAX = 2000;

const exists = (p: string) => stat(p).then(() => true, () => false);
/** In-memory state is per server, and a server talks to one GitHub host: no need to wait for it. */
const memId = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;

export function createScrutinizer(deps: ScrutinizeDeps) {
  /** What is being done to a PR's summary: written from scratch, or updated with new commits (never both). */
  const generating = new Map<string, 'write' | 'update'>();
  const genErrors = new Map<string, string>();
  const sinceCache = new Map<string, Since>();
  const timeouts = deps.timeoutMs ?? { summary: 30 * 60_000, answer: 15 * 60_000 };

  function gh(): GithubLike {
    const g = deps.github();
    if (!g) throw new Error('the github plugin is off');
    return g;
  }

  async function keyFor(ref: PrRef): Promise<PrKey> {
    return { host: await gh().host(), owner: ref.owner, repo: ref.repo, number: ref.number };
  }

  /**
   * The repo's local clone with the PR's head fetched, and the merge base with its base branch; null when there's no
   * clone of this repo or the commits can't be had (then the run gets the diff inline).
   */
  async function gitAccess(ref: PrRef, base: string, headOid: string, fetch: boolean): Promise<{ cwd: string; mergeBase: string } | null> {
    const clone = join(deps.reposDir, ref.repo);
    if (!(await exists(join(clone, '.git')))) return null;
    const git = (args: string[], timeoutMs = 30_000) => deps.run('git', ['-C', clone, ...args], { timeoutMs });
    const remote = await git(['remote', 'get-url', 'origin']).catch(() => '');
    const m = remote.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
    if (!m || m[1].toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) return null;
    // Best effort: the PR's head (forks too, through refs/pull) and the base, so the merge base is current.
    if (fetch) await git(['fetch', '--quiet', 'origin', base, `refs/pull/${ref.number}/head`], 180_000).catch(() => {});
    const has = await git(['cat-file', '-e', `${headOid}^{commit}`]).then(() => true, () => false);
    if (!has) return null;
    const mergeBase = await git(['merge-base', `origin/${base}`, headOid]).then((s) => s.trim(), () => '');
    return /^[0-9a-f]{40}$/.test(mergeBase) ? { cwd: clone, mergeBase } : null;
  }

  async function claude(name: string, prompt: string, cwd: string, tools: boolean, timeoutMs: number, maxTurns: number): Promise<string> {
    await mkdir(cwd, { recursive: true });
    const out = await deps.run(
      'claude',
      [
        '-p',
        '--model', deps.model(),
        '--name', `${RUN_PREFIX}${name}`,
        '--output-format', 'json',
        '--no-session-persistence',
        '--strict-mcp-config',
        // Bash only, and only read-only git in it: the clone's working tree isn't the PR, so file tools would mislead.
        ...(tools ? ['--tools', 'Bash', '--allowedTools', GIT_TOOLS] : ['--tools', '']),
        '--max-turns', String(maxTurns),
      ],
      { cwd, timeoutMs, input: prompt },
    );
    let env: { result?: string; is_error?: boolean; subtype?: string };
    try {
      env = JSON.parse(out) as typeof env;
    } catch {
      throw new Error(`claude -p printed something other than JSON: ${out.slice(0, 200)}`);
    }
    if (env.is_error || !env.result?.trim()) throw new Error(`claude -p failed: ${env.result?.slice(0, 300) || env.subtype || 'no result'}`);
    return env.result.trim();
  }

  const blobBase = (host: string, ref: PrRef, oid: string) => `https://${host}/${ref.owner}/${ref.repo}/blob/${oid}/`;

  /** Write (or rewrite) the summary. Long: run it as a job. Threads are kept, re-anchored to the new sections by title. */
  async function generate(ref: PrRef, progress: (d: string) => void = () => {}): Promise<{ path: string }> {
    const id = memId(ref);
    // Marked before the first await, so the tab's next poll sees it.
    if (generating.has(id)) throw new Error(`a summary of this PR is already being ${generating.get(id) === 'update' ? 'updated' : 'written'}`);
    generating.set(id, 'write');
    genErrors.delete(id);
    try {
      const g = gh();
      const key = await keyFor(ref);
      progress('reading the PR');
      const [d, files] = await Promise.all([g.prDetail(ref.owner, ref.repo, ref.number), g.prFiles(ref.owner, ref.repo, ref.number)]);
      progress('fetching its commits');
      const git = await gitAccess(ref, d.base, d.headOid, true);
      const access: CodeAccess = git ? { mode: 'git' } : { mode: 'inline', diff: inlineDiff(files) };
      const facts: PrFacts = {
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        url: d.url,
        title: d.title,
        body: d.body,
        author: d.author,
        base: d.base,
        head: d.head,
        headOid: d.headOid,
        mergeBase: git?.mergeBase ?? null,
        blobBase: blobBase(key.host, ref, d.headOid),
        files,
      };
      progress(git ? `writing the summary (${files.length} files, with the code)` : `writing the summary from the diff alone (${files.length} files; no local clone of ${ref.repo})`);
      let md = await claude(`summary-${ref.repo}-${ref.number}`, summaryPrompt(facts, access), git?.cwd ?? deps.scratchDir, !!git, timeouts.summary, 120);
      md = md.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, '$1').trim() + '\n';
      if (!/^#\s/m.test(md)) throw new Error(`the summary came back without a title: ${md.slice(0, 200)}`);
      const sections = splitSections(md);
      await deps.store.update(key, ({ meta }) => ({
        meta: {
          ...meta,
          generatedAt: new Date().toISOString(),
          headOid: d.headOid,
          mergeBase: git?.mergeBase ?? null,
          mode: access.mode,
          model: deps.model(),
          title: d.title,
          stats: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
          files: snapFiles(files),
          threads: meta.threads.map((t) => {
            const s = findSection(sections, t);
            return s ? { ...t, sectionId: s.id, sectionTitle: s.title } : t;
          }),
        },
        summary: md,
        result: null,
      }));
      return { path: deps.store.summaryPath(key) };
    } catch (e) {
      genErrors.set(id, (e as Error).message);
      throw e;
    } finally {
      generating.delete(id);
    }
  }

  /**
   * Bring the summary up to date with the PR's new commits, changing only the sections they affect (`updatePrompt`),
   * and log it in its Updates section. When the PR's diff is the same (new commits, e.g. a rebase), only the head moves.
   */
  async function update(ref: PrRef, progress: (d: string) => void = () => {}): Promise<{ path: string; upToDate: boolean; edits: number; skipped: string[] }> {
    const id = memId(ref);
    if (generating.has(id)) throw new Error(`a summary of this PR is already being ${generating.get(id) === 'update' ? 'updated' : 'written'}`);
    generating.set(id, 'update');
    genErrors.delete(id);
    try {
      const g = gh();
      const key = await keyFor(ref);
      const path = deps.store.summaryPath(key);
      const [meta, summary] = await Promise.all([deps.store.readMeta(key), deps.store.readSummary(key)]);
      if (!summary || !meta.headOid) throw new UserError('there is no summary to update yet');
      progress('reading the PR');
      const [d, files] = await Promise.all([g.prDetail(ref.owner, ref.repo, ref.number), g.prFiles(ref.owner, ref.repo, ref.number)]);
      if (d.headOid === meta.headOid) return { path, upToDate: true, edits: 0, skipped: [] };
      const since = changesSince(meta.files, snapFiles(files));
      let answer: UpdateAnswer;
      let mergeBase: string | null = meta.mergeBase;
      let mode = meta.mode;
      if (since.files === 0) {
        answer = { note: "New commits, but the PR's diff is the same; nothing in the guide changed.", edits: [] };
      } else {
        progress('fetching its commits');
        const git = await gitAccess(ref, d.base, d.headOid, true);
        const oldAvailable = git ? await deps.run('git', ['-C', git.cwd, 'cat-file', '-e', `${meta.headOid}^{commit}`]).then(() => true, () => false) : false;
        const touched = new Set([...since.newFiles, ...since.changedFiles]);
        const access: CodeAccess = git ? { mode: 'git' } : { mode: 'inline', diff: inlineDiff(files.filter((f) => touched.has(f.path))) };
        mergeBase = git?.mergeBase ?? null;
        mode = access.mode;
        const facts: PrFacts = {
          repo: `${ref.owner}/${ref.repo}`,
          number: ref.number,
          url: d.url,
          title: d.title,
          body: d.body,
          author: d.author,
          base: d.base,
          head: d.head,
          headOid: d.headOid,
          mergeBase,
          blobBase: blobBase(key.host, ref, d.headOid),
          files,
        };
        progress(`updating the summary (${since.files} ${since.files === 1 ? 'file' : 'files'} changed since)`);
        const text = await claude(
          `update-${ref.repo}-${ref.number}`,
          updatePrompt(facts, access, {
            summary,
            sections: splitSections(summary).map((s) => ({ id: s.id, title: s.title })),
            oldHead: meta.headOid,
            oldMergeBase: meta.mergeBase,
            oldAvailable,
            newFiles: since.newFiles,
            changedFiles: since.changedFiles,
            goneFiles: since.goneFiles,
          }),
          git?.cwd ?? deps.scratchDir,
          !!git,
          timeouts.summary,
          80,
        );
        answer = parseUpdate(text);
      }
      return await deps.store.update(key, ({ meta: cur, summary: doc }) => {
        if (!doc) throw new Error('the summary disappeared while it was being updated');
        const now = new Date().toISOString();
        const { markdown, skipped } = applyEdits(doc, answer.edits);
        const md = addUpdateNote(markdown, `**${now.slice(0, 10)}**, \`${(cur.headOid ?? '').slice(0, 7)}\` → \`${d.headOid.slice(0, 7)}\`: ${answer.note}`);
        const sections = splitSections(md);
        return {
          meta: {
            ...cur,
            updatedAt: now,
            headOid: d.headOid,
            mergeBase,
            mode,
            title: d.title,
            stats: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
            files: snapFiles(files),
            threads: cur.threads.map((t) => {
              const s = findSection(sections, t);
              return s ? { ...t, sectionId: s.id, sectionTitle: s.title } : t;
            }),
          },
          summary: md,
          result: { path, upToDate: false, edits: answer.edits.length - skipped.length, skipped },
        };
      });
    } catch (e) {
      genErrors.set(id, (e as Error).message);
      throw e;
    } finally {
      generating.delete(id);
    }
  }

  /** Start a thread, or add a follow-up to one; the caller then runs `answer` (as a job). */
  async function ask(ref: PrRef, body: { threadId?: unknown; sectionId?: unknown; quote?: unknown; question?: unknown }): Promise<Thread> {
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw new UserError('ask a question');
    if (question.length > QUESTION_MAX) throw new UserError(`keep the question under ${QUESTION_MAX} characters`);
    const key = await keyFor(ref);
    return deps.store.update(key, ({ meta, summary }) => {
      if (!summary) throw new UserError('there is no summary yet');
      const now = new Date().toISOString();
      if (typeof body.threadId === 'string' && body.threadId) {
        const t = meta.threads.find((x) => x.id === body.threadId);
        if (!t) throw new UserError('no such thread');
        if (t.pending) throw new UserError('that thread is still waiting for an answer');
        const next: Thread = { ...t, pending: true, error: null, messages: [...t.messages, { role: 'you', text: question, at: now }] };
        return { meta: { ...meta, threads: meta.threads.map((x) => (x.id === t.id ? next : x)) }, result: next };
      }
      const s = splitSections(summary).find((x) => x.id === body.sectionId);
      if (!s) throw new UserError('that section is no longer in the summary; reload');
      const quote = typeof body.quote === 'string' ? body.quote.trim().slice(0, QUOTE_MAX) : '';
      const t: Thread = {
        id: randomUUID().slice(0, 8),
        sectionId: s.id,
        sectionTitle: s.title,
        quote,
        messages: [{ role: 'you', text: question, at: now }],
        createdAt: now,
        pending: true,
        error: null,
      };
      return { meta: { ...meta, threads: [...meta.threads, t] }, result: t };
    });
  }

  /** Answer a thread's latest question (a no-op if it has none waiting, e.g. a resumed job that already finished). */
  async function answer(ref: PrRef, threadId: string, progress: (d: string) => void = () => {}): Promise<{ kind: string } | null> {
    const g = gh();
    const key = await keyFor(ref);
    const meta = await deps.store.readMeta(key);
    const summary = await deps.store.readSummary(key);
    const t = meta.threads.find((x) => x.id === threadId);
    if (!t?.pending || !summary) return null;
    try {
      const d = await g.prDetail(ref.owner, ref.repo, ref.number);
      const headOid = meta.headOid ?? d.headOid;
      // The code as the summary saw it, so answers and the guide agree.
      const git = meta.mode === 'git' ? await gitAccess(ref, d.base, headOid, false) : null;
      const files = git ? null : await g.prFiles(ref.owner, ref.repo, ref.number);
      const access: CodeAccess = git ? { mode: 'git' } : { mode: 'inline', diff: inlineDiff(files ?? []) };
      const section = findSection(splitSections(summary), t);
      const facts: PrFacts = {
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        url: d.url,
        title: d.title,
        body: d.body,
        author: d.author,
        base: d.base,
        head: d.head,
        headOid,
        mergeBase: git?.mergeBase ?? meta.mergeBase,
        blobBase: blobBase(key.host, ref, headOid),
        files: meta.files.length ? meta.files : (files ?? []),
      };
      const msgs = t.messages;
      const last = msgs[msgs.length - 1];
      progress('thinking');
      const text = await claude(
        `ask-${ref.repo}-${ref.number}-${t.id}`,
        askPrompt(facts, access, {
          summary,
          sectionTitle: section?.title ?? t.sectionTitle,
          sectionText: section?.text ?? '(this section is no longer in the guide)',
          quote: t.quote,
          history: msgs.slice(0, -1).map((m) => ({ role: m.role, text: m.text })),
          question: last.text,
        }),
        git?.cwd ?? deps.scratchDir,
        !!git,
        timeouts.answer,
        60,
      );
      const a = parseAnswer(text);
      return await deps.store.update(key, ({ meta: cur, summary: doc }) => {
        const th = cur.threads.find((x) => x.id === threadId);
        if (!th) return { meta: cur, result: null }; // removed meanwhile
        let next = doc;
        let kind = a.kind;
        let reply = a.reply;
        const sec = doc ? findSection(splitSections(doc), th) : null;
        if (kind !== 'reply' && doc && sec) {
          next = kind === 'addendum' ? applyAddendum(doc, sec.id, a.content, last.text) : applyRewrite(doc, sec.id, a.content);
        } else if (kind !== 'reply') {
          // The section is gone (regenerated meanwhile): keep the answer in the thread.
          kind = 'reply';
          reply = `${a.reply}\n\n${a.content}`;
        }
        const done: Thread = {
          ...th,
          sectionId: sec?.id ?? th.sectionId,
          pending: false,
          error: null,
          messages: [...th.messages, { role: 'claude', text: reply, at: new Date().toISOString(), kind }],
        };
        return { meta: { ...cur, threads: cur.threads.map((x) => (x.id === threadId ? done : x)) }, summary: next, result: { kind } };
      });
    } catch (e) {
      await deps.store.update(key, ({ meta: cur }) => ({
        meta: { ...cur, threads: cur.threads.map((x) => (x.id === threadId ? { ...x, pending: false, error: (e as Error).message } : x)) },
        result: null,
      }));
      throw e;
    }
  }

  async function removeThread(ref: PrRef, threadId: string): Promise<void> {
    await deps.store.update(await keyFor(ref), ({ meta }) => ({ meta: { ...meta, threads: meta.threads.filter((t) => t.id !== threadId) }, result: null }));
  }

  /** What the tab shows. `head`: the PR's current head; when it differs from the summary's, say how much changed. */
  async function view(ref: PrRef, head: string | null): Promise<SummaryView> {
    const key = await keyFor(ref);
    const id = memId(ref);
    const [meta, markdown] = await Promise.all([deps.store.readMeta(key), deps.store.readSummary(key)]);
    let since: Since | null = null;
    let sinceError: string | null = null;
    if (markdown && head && meta.headOid && head !== meta.headOid) {
      const cacheKey = `${keyId(key)}|${meta.generatedAt}|${meta.headOid}|${head}`;
      since = sinceCache.get(cacheKey) ?? null;
      if (!since) {
        try {
          since = changesSince(meta.files, snapFiles(await gh().prFiles(ref.owner, ref.repo, ref.number)));
          if (sinceCache.size > 200) sinceCache.clear();
          sinceCache.set(cacheKey, since);
        } catch (e) {
          sinceError = (e as Error).message;
        }
      }
    }
    return {
      exists: !!markdown,
      markdown,
      path: deps.store.summaryPath(key),
      generatedAt: meta.generatedAt,
      updatedAt: meta.updatedAt,
      headOid: meta.headOid,
      model: meta.model,
      mode: meta.mode,
      stats: meta.stats,
      since,
      sinceError,
      threads: meta.threads,
      generating: generating.get(id) === 'write',
      updating: generating.get(id) === 'update',
      error: genErrors.get(id) ?? null,
    };
  }

  /** Where the PR's summary.md is (or will be). */
  const pathFor = async (ref: PrRef) => deps.store.summaryPath(await keyFor(ref));

  return { generate, update, ask, answer, removeThread, view, pathFor, isGenerating: (ref: PrRef) => generating.has(memId(ref)) };
}

/** A problem with the request (400), not a failure of the work. */
export class UserError extends Error {}
