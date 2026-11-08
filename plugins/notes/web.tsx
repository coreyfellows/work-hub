import type { WebPluginContext } from '../../plugin-api/web.ts';
import { NotePane } from './NotePane.tsx';

export type { NoteInfo } from './types.ts';

export default function register(ctx: WebPluginContext): void {
  // Order 101: after the core's Diff tab (100), before Code (102), as before the plugins.
  ctx.contribute('workspace-panel', { id: 'note', label: 'Note', wide: true, order: 101, component: NotePane });
}
