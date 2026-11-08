import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { readJson, type ServerPluginContext, type Workspace } from '../../plugin-api/server.ts';
import { authorPrompt, branchSlug, cleanPath, resolveDestination, validateCreate, type Destination, type PathKind } from './create.ts';

/** What the form needs besides `GET /api/plugins`: whether official is possible, the local folders, the taken ids. */
export interface CreateOptions {
  officialAvailable: boolean;
  /** plugins.json `local`, each marked usable (a folder of plugins) or not, with why. */
  folders: Array<{ path: string; usable: boolean; why?: string }>;
  /** Every id and alias found, built-ins included. */
  taken: string[];
  /** plugins.json couldn't be read (the form still works for official plugins). */
  configError?: string;
}

function pathKind(p: string): PathKind {
  try {
    if (!statSync(p).isDirectory()) return 'file';
    return readdirSync(p).length ? 'dir' : 'empty-dir';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'file';
  }
}

export default function register(ctx: ServerPluginContext): void {
  const repoRoot = ctx.paths.repoRoot;
  const git = (args: string[], timeoutMs = 20_000) => ctx.exec.run('git', ['-C', repoRoot, ...args], { timeoutMs }).then((s) => s.trim());

  // An extracted tarball can't take an official plugin usefully (no branch to commit to): official only from a checkout.
  let official: Promise<boolean> | null = null;
  const officialAvailable = () =>
    (official ??= git(['rev-parse', '--show-toplevel']).then(
      (top) => realpathSync(top) === realpathSync(repoRoot),
      () => false,
    ));

  // A local entry that isn't a folder gets a placeholder id (its basename) from discovery: not a real plugin, so not taken.
  const taken = () => new Set(ctx.plugins.list().filter((p) => !(p.kind === 'local' && p.reason === 'not a folder')).flatMap((p) => [p.id, ...p.aliases]));

  const folders = (): Pick<CreateOptions, 'folders' | 'configError'> => {
    let local: string[];
    try {
      local = ctx.plugins.config().local;
    } catch (e) {
      return { folders: [], configError: (e as Error).message };
    }
    return {
      folders: local.map((path) => {
        const k = pathKind(path);
        if (k === 'missing' || k === 'file') return { path, usable: false, why: 'not a folder' };
        if (existsSync(join(path, 'plugin.json'))) return { path, usable: false, why: 'a plugin, not a folder' };
        return { path, usable: true };
      }),
    };
  };

  /** The worktree's base: the checkout's upstream when the checkout has nothing it lacks, else its branch, else its commit. */
  const baseRef = async (): Promise<string> => {
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '');
    if (upstream && (await git(['merge-base', '--is-ancestor', 'HEAD', upstream]).then(() => true, () => false))) return upstream;
    return (await git(['branch', '--show-current']).catch(() => '')) || 'HEAD';
  };

  ctx.revalidate(['/api/plugins/plugin-author/options']);
  ctx.app.get('/api/plugins/plugin-author/options', async (c) => {
    const body: CreateOptions = { officialAvailable: await officialAvailable(), taken: [...taken()].sort(), ...folders() };
    return c.json(body);
  });

  ctx.app.post('/api/plugins/plugin-author/create', async (c) => {
    const body = await readJson(c);
    const v = validateCreate(body, { taken: taken(), officialAvailable: await officialAvailable(), repoRoot });
    if (!v.ok) return c.json({ error: v.error }, 400);
    const input = v.input;

    let dest: Destination | null = null;
    if (!input.official) {
      const usable = folders().folders.filter((f) => f.usable).map((f) => f.path);
      const r = resolveDestination({ destination: input.destination!, name: input.name }, { folders: usable, kind: pathKind });
      if (!r.ok) return c.json({ error: r.error }, 400);
      dest = r.dest;
    }

    // Everything made from here on is taken back if a later step fails: nothing half-made is left behind.
    const undo: Array<(err: unknown) => Promise<void> | void> = [];
    try {
      const slug = branchSlug(input.name, input.description, randomBytes(2).toString('hex'));
      const branch = `plugin-${slug}`;
      const repoName = (await ctx.git.branchInfo(repoRoot).catch(() => null))?.repo?.split('/').pop() || basename(repoRoot);
      const worktree = join(ctx.paths.worktreesDir, repoName, branch);
      const base = await baseRef();
      // The session runs in a worktree, never in the checkout the app runs from.
      await git(['worktree', 'add', worktree, '-b', branch, base], 60_000);
      undo.push(async () => {
        await git(['worktree', 'remove', '--force', worktree]).catch((e) => ctx.log.warn('undo: worktree remove', e));
        await git(['branch', '-D', branch]).catch((e) => ctx.log.warn('undo: branch delete', e));
      });
      await ctx.sessions.trustWorktree(worktree);

      if (dest && !existsSync(dest.create)) {
        // The folder the session may write to (`--add-dir` needs it to exist); removed again only while still empty.
        const made = cleanPath(dest.create);
        mkdirSync(made, { recursive: true });
        undo.push(() => {
          if (pathKind(made) === 'empty-dir') rmdirSync(made);
        });
      }

      const title = `Plugin: ${input.name ?? input.description.split('\n')[0].slice(0, 60)}`;
      const id = ctx.store.createWorkspace({ title, origin: 'prompt', prompt: input.description, status: 'active' });
      // The store has no delete: a failed start leaves the workspace done (off the front page), saying why.
      undo.push((err) => {
        ctx.store.removeWorktreeRecord(id, worktree);
        ctx.store.logEvent(id, 'create-failed', err instanceof Error ? err.message : String(err));
        ctx.store.setStatus(id, 'done');
      });
      ctx.store.addWorktree(id, { repo: repoName, path: worktree, branch, baseBranch: base });
      const ws = ctx.store.getWorkspace(id) as Workspace;

      const model = ctx.config.get('model', 'opus') ?? 'opus';
      const prompt = authorPrompt({
        workspaceId: id,
        input,
        dest,
        worktree,
        branch,
        base,
        appRepo: repoRoot,
        configFile: ctx.plugins.configFile,
        whCommand: ctx.paths.whCommand,
        rules: ctx.prompts.workspaceRules(id),
      });
      const { shortId, sessionId } = await ctx.sessions.startBackground({
        cwd: worktree,
        name: ws.title,
        model,
        prompt,
        purpose: 'plugin-author',
        addDirs: dest ? [dest.addDir] : [],
      });
      ctx.store.addSession(id, { claudeSessionId: sessionId, role: 'author', name: ws.title, cwd: worktree });
      ctx.store.logEvent(id, 'dispatched', `plugin author ${shortId} (${model})`);
      void ctx.registry.refresh('workspaces').catch(() => {});
      void ctx.registry.refresh('claude').catch(() => {});
      return c.json({ ok: true, workspace: ctx.store.getWorkspace(id) });
    } catch (err) {
      for (const fn of undo.reverse()) {
        try {
          await fn(err);
        } catch (e) {
          ctx.log.warn('undo failed:', e);
        }
      }
      void ctx.registry.refresh('workspaces').catch(() => {});
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
