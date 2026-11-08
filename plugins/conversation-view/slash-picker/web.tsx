import type { WebPluginContext } from '../../../plugin-api/web.ts';
import { SlashPicker } from './SlashMenu.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('composer-addon', { id: 'slash-picker', component: SlashPicker });
  ctx.contribute('shortcut', { group: 'Prompt box', keys: ['/'], label: 'Slash commands', where: 'at the start of the box' });
  ctx.contribute('shortcut', { group: 'Prompt box', keys: ['Tab'], label: 'Pick the highlighted slash command (↑ ↓ to move, Esc to dismiss)', where: 'while the list is open' });
}
