import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { createHgProvider } from './provider.ts';

/** Registers the hg source-control provider (experimental; see README.md). */
export default function register(ctx: ServerPluginContext): void {
  ctx.vcs.register(createHgProvider({ run: ctx.exec.run }));
}
