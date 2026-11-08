import type { WebPluginContext } from '../../plugin-api/web.ts';
import { useScreenActivity } from './activity.ts';
import { TerminalView } from './TerminalView.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // Order 10: first among the session views, before Chat and Log (as it was when the core drew it).
  ctx.contribute('session-view', { id: 'terminal', label: 'Terminal', default: true, liveDot: true, order: 10, component: TerminalView });
  ctx.contribute('working-activity', { useActivity: useScreenActivity });
}
