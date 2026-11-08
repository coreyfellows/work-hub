import { readJson, type ServerPluginContext } from '../../plugin-api/server.ts';
import { dispatchWorkspace, NeedsConfirm, resumeDispatch, ticketWorkflowRules, type DispatchInput, type DispatchSettings } from './dispatch.ts';

export default function register(ctx: ServerPluginContext): void {
  const env = process.env;
  const settings: DispatchSettings = {
    ctx,
    // Picking repos and base branches from a ticket is judgment-heavy, so the explorer gets the top model.
    explorerModel: ctx.config.get('explorerModel', env.WORK_HUB_EXPLORER_MODEL ?? 'opus'),
    // Read on use (Settings and the first-run page can set it while the app runs); empty (the default): no Jira link.
    get jiraBaseUrl() {
      return ctx.config.get('jiraBaseUrl', env.TW_JIRA_BASE_URL ?? '');
    },
    whCommand: ctx.paths.whCommand,
    // Read on use: the ticket-workflow plugin's scripts, while it's on.
    get ticketWorkflowScripts() {
      return ctx.paths.ticketWorkflowScripts;
    },
  };

  // The ticket-workflow conventions every workspace session is told, after the core's generic rules (none for a
  // workspace without git: `kinds`).
  ctx.prompts.addFragment('workspace-rules', ({ workspaceId, kinds }) =>
    ticketWorkflowRules({
      ticketKey: (workspaceId && ctx.store.getWorkspace(workspaceId)?.ticketKey) || null,
      worktreesDir: ctx.paths.worktreesDir,
      ticketWorkflowScripts: ctx.paths.ticketWorkflowScripts,
      whCommand: ctx.paths.whCommand,
      kinds,
    }),
  );

  // New workspace: create it, then start its explorer, or for a plain folder its main session (synchronous: the page
  // navigates to the workspace it gets back). A folder outside the roots that isn't confirmed yet: 409 { needsConfirm }.
  ctx.app.post('/api/workspaces', async (c) => {
    const body = await readJson<DispatchInput>(c);
    try {
      const ws = await dispatchWorkspace(settings, body);
      void ctx.registry.refresh('workspaces').catch(() => {});
      void ctx.registry.refresh('claude').catch(() => {});
      return c.json({ ok: true, workspace: ws });
    } catch (err) {
      if (err instanceof NeedsConfirm) return c.json({ needsConfirm: err.path }, 409);
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // A workspace made just before a restart, whose explorer never started, gets it now.
  ctx.onStart(() => void resumeDispatch(settings));
}
