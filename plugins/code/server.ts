import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { codeLinks } from './code.ts';

export default function register(ctx: ServerPluginContext): void {
  // Old env names are still honoured as defaults (WORK_HUB_CODE_URL is already this plugin's own name for `url`).
  const opts = {
    url: ctx.config.get('url', '/code'),
    tokenFile: ctx.config.get('vscodeTokenFile', process.env.TW_VSCODE_TOKEN_FILE ?? join(homedir(), '.local/state/vscode-serve-web.token')),
  };

  /** VS Code links for the workspace's worktrees (for the Code tab). */
  ctx.app.get('/api/plugins/code/workspaces/:id', async (c) => {
    const ws = ctx.store.getWorkspace(c.req.param('id'));
    if (!ws) return c.json({ error: 'no such workspace' }, 404);
    return c.json(await codeLinks(ws, opts));
  });
}
