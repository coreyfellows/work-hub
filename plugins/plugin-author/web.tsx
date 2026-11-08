import { navigate, type WebPluginContext } from '../../plugin-api/web.ts';
import { NewPluginPage } from './NewPluginPage.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // No nav tab: Settings → Plugins' button and the palette lead here.
  ctx.contribute('page', { path: '/plugins/new', component: NewPluginPage });
  ctx.contribute('plugins-action', {
    id: 'create-plugin',
    component: () => (
      <button className="primary" onClick={() => navigate('/plugins/new')}>
        Create plugin
      </button>
    ),
  });
  ctx.contribute('palette-commands', {
    commands: () => [{ id: 'create-plugin', label: 'Create plugin', hint: 'describe it; a Claude session builds it', group: 'Plugins', run: () => navigate('/plugins/new') }],
  });
}
