import type { WebPluginContext } from '../../../plugin-api/web.ts';
import { AllowedToolsSetting } from './AllowedToolsSetting.tsx';
import { PermissionAddon } from './PermissionPrompt.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // Before the question form: a session shows one or the other, never both.
  ctx.contribute('composer-addon', { id: 'permissions', order: 5, component: PermissionAddon });
  ctx.contribute('settings-section', { id: 'session-permissions', title: 'Session permissions', order: 25, scope: 'app', component: AllowedToolsSetting });
}
