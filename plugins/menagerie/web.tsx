import type { HostProviderItem, SlotInput, WebPluginContext } from '../../plugin-api/web.ts';
import { CastEditor } from './CastEditor.tsx';
import { FacesPage } from './FacesPage.tsx';
import { SetupBanner } from './SetupBanner.tsx';
import { GEN_JOB_KIND } from './editorState.ts';
import { askLine, hostVars, lastHost, splitAside, useFunHosts } from './menagerie.ts';
import { AsideCard, AskHeader, HostInContext, QuipScope, WorkingPulse, frame, useQuipPhase } from './parts.tsx';

export type { FunHost } from './types.ts';

/** The hosts to style with. Switching the plugin off in Settings → Plugins is what turns the styling off. */
function useHosts() {
  return useFunHosts();
}

/** The host-provider API's "is it on" hook: the plugin being loaded is the switch, so always. */
const useMenagerieOn = () => true;

const provider: SlotInput<'host-provider'> = {
  useHosts,
  useMenagerieOn,
  lastHost,
  splitAside,
  askLine,
  hostVars,
  frame,
  AsideCard,
  WorkingPulse,
  AskHeader,
  HostInContext,
  useQuipPhase,
  QuipScope,
} satisfies Omit<HostProviderItem, 'plugin'>;

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('host-provider', provider);
  ctx.contribute('page', { path: '/settings/faces', component: () => <FacesPage /> });
  // On every page: the cast's animation stylesheet, the job watcher, and the "set up your cast" prompt while it's empty.
  ctx.contribute('app-banner', { id: 'menagerie-setup', component: SetupBanner });
  ctx.contribute('settings-section', { id: 'cast', title: 'Your cast', order: 40, component: CastEditor });
  ctx.contribute('job-kind', { kind: GEN_JOB_KIND, icon: '🎭', label: 'Menagerie' });
}
