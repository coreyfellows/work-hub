/**
 * Settings → Source control: the provider new workspaces prefer. A static list (so the Settings form needs no provider
 * lookup); a value naming a provider that isn't registered (its plugin is off) reads as `detect`.
 */
import { config } from '../../config.ts';
import type { SettingGroup } from '../../settings.ts';
import { getProvider } from './registry.ts';

export const VCS_GROUP = 'vcs';
export const VCS_DEFAULT_KEY = `${VCS_GROUP}.default`;

export function vcsGroup(): SettingGroup {
  return {
    id: VCS_GROUP,
    title: 'Source control',
    description:
      'Which source control new workspaces use. Detect looks at the folder (git first, then the others, plain folder last). Jujutsu, Mercurial and Perforce are experimental plugins that must be switched on in Plugins.',
    order: 26,
    builtin: true,
    defs: [
      {
        key: 'default',
        label: 'Default source control',
        description: 'A workspace can still choose its own. A choice whose plugin is off counts as Detect.',
        type: 'select',
        options: [
          { value: 'detect', label: 'Detect (default)' },
          { value: 'git', label: 'git' },
          { value: 'folder', label: 'Plain folder' },
          { value: 'jj', label: 'Jujutsu (jj)' },
          { value: 'hg', label: 'Mercurial (hg)' },
          { value: 'p4', label: 'Perforce (p4)' },
        ],
        default: 'detect',
        env: 'WORK_HUB_VCS_DEFAULT',
      },
    ],
  };
}

/** The default provider id to `prefer`, or null for Detect (or a provider that isn't registered). */
export function effectiveVcsDefault(): string | null {
  const id = config.vcsDefault;
  return id && id !== 'detect' && getProvider(id) ? id : null;
}
