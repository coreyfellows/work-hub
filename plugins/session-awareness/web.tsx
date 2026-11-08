import type { WebPluginContext } from '../../plugin-api/web.ts';
import { hasSiblings } from './glance.ts';
import { SessionsGlance } from './SessionsGlance.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // Details → Sessions at a glance, after Pull requests (20) and before Worktrees (30).
  ctx.contribute('workspace-section', {
    id: 'sessions-glance',
    title: 'Sessions at a glance',
    order: 25,
    // One open session has no siblings to show (recorded sessions include closed ones).
    isEmpty: (ws, sources) => !hasSiblings(ws.sessions, (sources.claude?.data as { sessions?: Array<{ sessionId: string; status: string }> } | null | undefined)?.sessions ?? []),
    component: ({ workspace }) => (
      <section className="block flush">
        <h3>Sessions at a glance</h3>
        <SessionsGlance workspace={workspace} />
      </section>
    ),
  });
}
