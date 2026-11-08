import type { WebPluginContext } from '../../plugin-api/web.ts';
import { SummaryTab } from './SummaryTab.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // The PR page's fourth tab (/prs/:owner/:repo/:number#summary); only there while the github plugin is on.
  ctx.contribute('pr-tab', { id: 'summary', label: 'Summary', component: SummaryTab });
  ctx.contribute('job-kind', { kind: 'scrutinize', icon: '🔎', label: 'PR summary' });
  ctx.contribute('job-kind', { kind: 'scrutinize-update', icon: '🔁', label: 'PR summary update' });
  ctx.contribute('job-kind', { kind: 'scrutinize-ask', icon: '💬', label: 'PR question' });
}
