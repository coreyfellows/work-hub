import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { appRules } from './rules.ts';

export default function register(ctx: ServerPluginContext): void {
  // Scripts Claude writes for the user live in work-hub's own storage (not /tmp, which the OS clears). The file viewer
  // and the Run card's "View script" can read this folder.
  const scriptsDir = join(ctx.paths.pluginState, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  ctx.files.addRoot(scriptsDir);
  // Core appends this to the prompt of every session it starts (except headless helpers). Those sessions get the rules
  // that way only: the skill in claude/ is for sessions started by hand (README).
  // Each section's switch and your own rules come from Settings, read for every prompt, so a change applies to the next session.
  ctx.prompts.addFragment('app-rules', () =>
    appRules(scriptsDir, {
      commands: ctx.config.get('ruleCommands', true),
      questions: ctx.config.get('ruleQuestions', true),
      vault: ctx.config.get('ruleVault', false),
      notes: ctx.config.get('ruleNotes', true),
      extra: ctx.config.get('extraRules', ''),
    }),
  );
}
