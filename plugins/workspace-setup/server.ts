import { readJson, type ServerPluginContext } from '../../plugin-api/server.ts';
import { dispatchWorkspace, resumeDispatch, ticketWorkflowRules, type DispatchSettings } from './dispatch.ts';

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

  // The ticket-workflow conventions every workspace session is told, after the core's generic rules.
  ctx.prompts.addFragment('workspace-rules', ({ workspaceId }) =>
    ticketWorkflowRules({
      ticketKey: (workspaceId && ctx.store.getWorkspace(workspaceId)?.ticketKey) || null,
      worktreesDir: ctx.paths.worktreesDir,
      ticketWorkflowScripts: ctx.paths.ticketWorkflowScripts,
      whCommand: ctx.paths.whCommand,
    }),
  );

  // New workspace: create it, then start its explorer (synchronous: the page navigates to the workspace it gets back).
  ctx.app.post('/api/workspaces', async (c) => {
    const body = await readJson<{ ticket?: string; prompt?: string }>(c);
    try {
      const ws = await dispatchWorkspace(settings, body);
      void ctx.registry.refresh('workspaces').catch(() => {});
      void ctx.registry.refresh('claude').catch(() => {});
      return c.json({ ok: true, workspace: ws });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // A workspace made just before a restart, whose explorer never started, gets it now.
  ctx.onStart(() => void resumeDispatch(settings));
}
