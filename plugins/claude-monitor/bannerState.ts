/** What the banner says, and what Start/Skip send: pure, so the web half's logic is unit-tested. */
import type { MonitorData } from './types.ts';

export type Banner =
  | { kind: 'none' }
  | { kind: 'updating'; installed: string | null }
  | { kind: 'update'; installed: string; latest: string }
  | { kind: 'whats-new'; installed: string };

/**
 * `dismissedUpdate`: the version whose update offer the user hid on this device (a newer one shows again). What's new
 * wins over an update offer only when there's no newer version to install (the modal shows both ranges anyway).
 */
export function bannerFor(d: MonitorData | null | undefined, dismissedUpdate: string | null): Banner {
  if (!d) return { kind: 'none' };
  if (d.updating) return { kind: 'updating', installed: d.installed };
  if (d.updateAvailable && d.installed && d.latest && d.latest !== dismissedUpdate) return { kind: 'update', installed: d.installed, latest: d.latest };
  if (d.whatsNew && d.installed) return { kind: 'whats-new', installed: d.installed };
  return { kind: 'none' };
}

/** Ticked plugins are updated; the rest of the suggested ones are skipped for this version. */
export function applyBody(version: string, suggested: string[], ticked: Set<string>, skipRest: boolean): { version: string; update: string[]; skip: string[] } {
  const update = suggested.filter((id) => ticked.has(id));
  return { version, update, skip: skipRest ? suggested.filter((id) => !ticked.has(id)) : [] };
}
