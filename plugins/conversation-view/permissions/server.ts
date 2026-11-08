import { join } from 'node:path';
import type { ServerPluginContext } from '../../../plugin-api/server.ts';
import { ansiToHtml, readJson } from '../../../plugin-api/server.ts';
import { allowArgs, checkRules, defaultRules, loadRules, saveRules } from './allowlist.ts';
import { parsePermissionPrompt, sameLabel, type PermissionPrompt } from './prompt.ts';
import { allowRuleFor, rememberOption } from './rule.ts';

export default function register(ctx: ServerPluginContext): void {
  const allowlist = registerAllowlist(ctx);

  // Polled by the card while a session sits at a permission menu: an unchanged screen is an empty 304.
  ctx.revalidate(['/api/sessions/:id/permission']);

  async function screenPrompt(shortId: string): Promise<PermissionPrompt | null> {
    const raw = await ctx.exec.run('claude', ['logs', shortId], { timeoutMs: 10_000 }).catch(() => '');
    if (!raw) return null;
    const text = (await ansiToHtml(raw, 80))
      .replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return parsePermissionPrompt(text);
  }

  /** The permission menu on the session's screen right now (`prompt: null` when there isn't one), and the allowlist rule "Always allow" would save (`rule`, null when none can be derived). */
  ctx.app.get('/api/sessions/:id/permission', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    if (s.kind !== 'background') return c.json({ prompt: null, rule: null });
    const prompt = await screenPrompt(s.shortId);
    return c.json({ prompt, rule: prompt ? allowRuleFor(prompt) : null });
  });

  /**
   * Pick a choice in the permission menu by typing its number. Refuses unless the menu is still on screen with that
   * exact choice under that number, so a stale card can't press a key into some other menu or the prompt.
   * With `always: true` (on the "Yes" choice) the allowlist rule for what's on screen is saved first, so sessions started
   * from now on don't ask; the running session is told "don't ask again" too when Claude's menu offers that choice.
   */
  ctx.app.post('/api/sessions/:id/permission', async (c) => {
    const s = await ctx.sessions.find(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    if (s.kind !== 'background') return c.json({ error: 'only background sessions can be answered from here' }, 409);
    const body = await readJson<{ option: number; label: string; always?: boolean }>(c);
    if (!Number.isInteger(body.option) || body.option < 1 || body.option > 9 || typeof body.label !== 'string') {
      return c.json({ error: 'pick one of the choices' }, 400);
    }
    const prompt = await screenPrompt(s.shortId);
    if (!prompt) return c.json({ error: "there's no permission prompt on Claude's screen any more" }, 409);
    const choice = prompt.options.find((o) => o.n === body.option);
    if (!choice || !sameLabel(choice.label, body.label)) {
      return c.json({ error: 'the prompt on screen has changed; pick again' }, 409);
    }
    let pressed = choice;
    let saved: { rule: string; added: boolean } | undefined;
    if (body.always) {
      const rule = allowRuleFor(prompt);
      if (choice.n !== 1 || !rule) return c.json({ error: "this request can't be remembered as a rule; use Settings → Session permissions" }, 409);
      try {
        saved = { rule, added: await allowlist.addRule(rule) };
      } catch (err) {
        return c.json({ error: `couldn't save the rule: ${(err as Error).message}` }, 500);
      }
      pressed = rememberOption(prompt) ?? choice;
    }
    try {
      await ctx.sessions.typeSequence(s.shortId, [String(pressed.n)]);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    void ctx.registry.refresh('claude');
    return c.json({ ok: true, ...(saved ? { rule: saved.rule, added: saved.added } : {}) });
  });
}

/** Settings → Session permissions: the allowlist every session work-hub starts gets (see allowlist.ts). */
function registerAllowlist(ctx: ServerPluginContext): { addRule(rule: string): Promise<boolean> } {
  const file = join(ctx.paths.pluginState, 'allowed-tools.json');
  // null = never changed: the defaults apply (computed when used, so they follow the configured paths).
  let saved: string[] | null = null;
  const ready = loadRules(file).then((r) => {
    saved = r;
  });
  const current = () => saved ?? defaultRules(ctx.paths);

  ctx.sessions.addLaunchArgs(async () => {
    await ready;
    return allowArgs(current());
  });

  ctx.app.get('/api/permissions/allowed-tools', async (c) => {
    await ready;
    return c.json({ rules: current(), defaults: defaultRules(ctx.paths), custom: saved !== null });
  });

  /** `{ rules: string[] }` saves the list; `{ reset: true }` goes back to the defaults. Applies to sessions started from now on. */
  ctx.app.post('/api/permissions/allowed-tools', async (c) => {
    await ready;
    const body = await readJson<{ rules?: unknown; reset?: boolean }>(c);
    if (body.reset) {
      await saveRules(file, null);
      saved = null;
    } else {
      const r = checkRules(body.rules);
      if (!r.ok) return c.json({ error: r.error }, 400);
      await saveRules(file, r.rules);
      saved = r.rules;
    }
    return c.json({ rules: current(), defaults: defaultRules(ctx.paths), custom: saved !== null });
  });

  return {
    /** Adds a rule to the list (saving it, which makes the list custom); false when it was already there. */
    async addRule(rule: string): Promise<boolean> {
      await ready;
      const list = current();
      if (list.includes(rule)) return false;
      const r = checkRules([...list, rule]);
      if (!r.ok) throw new Error(r.error);
      await saveRules(file, r.rules);
      saved = r.rules;
      return true;
    },
  };
}
