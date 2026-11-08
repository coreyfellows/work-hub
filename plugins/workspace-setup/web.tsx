import { Link, navigate, type WebPluginContext } from '../../plugin-api/web.ts';
import { NewWorkspacePage } from './NewWorkspacePage.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // A static path, so it wins over the core's `/workspaces/:id` (no nav tab: the front page's button leads here).
  ctx.contribute('page', { path: '/workspaces/new', component: NewWorkspacePage });
  ctx.contribute('palette-commands', {
    order: 10,
    commands: () => [{ id: 'new-workspace', label: 'New workspace', hint: 'start from a ticket or a prompt', group: 'Workspace', run: () => navigate('/workspaces/new') }],
  });
  ctx.contribute('workspace-list-action', {
    id: 'new-workspace',
    component: () => (
      <Link to="/workspaces/new" className="button">
        + New workspace
      </Link>
    ),
  });
}
