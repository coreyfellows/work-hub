import type { WebPluginContext } from '../../plugin-api/web.ts';
import { SessionStatsBar } from './SessionStatsBar.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('session-header', { id: 'stats', component: ({ sessionId }) => <SessionStatsBar sessionId={sessionId} /> });
}
