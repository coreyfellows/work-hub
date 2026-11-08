import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { createP4Provider, parseTemplates } from './provider.ts';

/** Registers the p4 source-control provider (experimental; see README.md). `templates` comes from plugins.json only. */
export default function register(ctx: ServerPluginContext): void {
  const templates = parseTemplates(ctx.config.get('templates', []));
  ctx.vcs.register(createP4Provider({ run: ctx.exec.run, templates }));
}
