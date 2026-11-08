import type { WebPluginContext } from '../../../plugin-api/web.ts';
import { QuestionAddon } from './QuestionForm.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('composer-addon', { id: 'questions', order: 10, component: QuestionAddon });
  ctx.contribute('shortcut', { group: 'Prompt box', keys: ['Up', 'Down'], label: "Move between a question's options", where: 'when Claude is asking' });
  ctx.contribute('shortcut', { group: 'Prompt box', keys: [' '], label: 'Pick the focused option', where: 'when Claude is asking' });
  ctx.contribute('shortcut', { group: 'Prompt box', keys: ['Enter'], label: 'Pick the focused option and send (or go to the next question)', where: 'when Claude is asking' });
}
