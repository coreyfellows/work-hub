import type { ServerPluginContext } from '../../../plugin-api/server.ts';
import { editEnricher } from './edits.ts';

export default function register(ctx: ServerPluginContext): void {
  ctx.transcript.addEnricher(editEnricher);
}
