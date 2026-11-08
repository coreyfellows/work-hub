import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { createJjProvider } from './provider.ts';

/** Registers the jj source-control provider (experimental; see README.md). */
export default function register(ctx: ServerPluginContext): void {
  ctx.vcs.register(createJjProvider({ run: ctx.exec.run }));
}
