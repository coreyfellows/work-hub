import { post, type WebPluginContext } from '../../plugin-api/web.ts';
import { ClaudeBanner } from './Banner.tsx';
import { PluginVersions } from './PluginVersions.tsx';
import { ANALYZE_JOB, API, APPLY_JOB, UPDATE_JOB } from './types.ts';
import { openWhatsNew } from './WhatsNew.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('app-banner', { id: 'claude-monitor', component: ClaudeBanner });
  ctx.contribute('settings-section', { id: 'claude-monitor-versions', title: 'Versions', component: PluginVersions });
  ctx.contribute('job-kind', { kind: UPDATE_JOB, icon: '⬆', label: 'Claude Code update' });
  ctx.contribute('job-kind', { kind: ANALYZE_JOB, icon: '✨', label: 'Plugin ideas' });
  ctx.contribute('job-kind', { kind: APPLY_JOB, icon: '🧩', label: 'Plugin updates' });
  ctx.contribute('palette-commands', {
    commands: () => [
      { id: 'claude-monitor:whats-new', label: "Claude Code: what's new", hint: 'release notes and plugin suggestions', group: 'Claude Code', run: openWhatsNew },
      { id: 'claude-monitor:check', label: 'Claude Code: check for updates', group: 'Claude Code', run: () => post(`${API}/check`, {}).then(() => undefined) },
    ],
  });
}
