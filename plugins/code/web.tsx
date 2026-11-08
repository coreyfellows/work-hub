import type { WebPluginContext } from '../../plugin-api/web.ts';
import { CodePane } from './CodePane.tsx';

export type { CodeLink } from './types.ts';

export default function register(ctx: WebPluginContext): void {
  // Order 102: after Diff (100) and Note (101), as before the plugins.
  ctx.contribute('workspace-panel', { id: 'code', label: 'Code', wide: true, order: 102, component: CodePane });
}
