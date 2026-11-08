import type { HostProviderItem, HostRef } from '../../plugin-api/web.ts';
import { useSlotOnce } from './slots.ts';

/**
 * The resident-host provider (`host-provider` slot: the menagerie plugin), or undefined: then asides stay Markdown and
 * nothing is themed. Read once per component (plugins contribute before the first render), so calling its hooks
 * behind `hp ?` keeps the hook count stable.
 */
export function useHostProvider(): HostProviderItem | undefined {
  return useSlotOnce('host-provider')[0];
}

/** The provider's hosts, null without one or when it's switched off on this device. */
export function useProviderHosts(hp: HostProviderItem | undefined): HostRef[] | null {
  return hp ? hp.useHosts() : null;
}
