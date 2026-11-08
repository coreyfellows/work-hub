import type { SourceState } from './api.ts';
import type { HealthIssuesItem } from '../../plugin-api/web.ts';
import { slotItems } from './slots.ts';

/**
 * One place that decides the app's health dot:
 *   🔴 fire    — changes requested on one of my PRs, or a connection problem (local auth, MCP servers,
 *               a plugin's services, a data source that can't fetch)
 *   🟠 waiting — a Claude session is waiting on me
 *   🟢 ok
 * Warnings (e.g. a plugin's lapsed, unwatched services) are listed on the Status page only. Issues come from the core
 * (a source that can't update) and the `health-issues` slot (the health plugin's checks and MCP servers, PRs, other plugins' checks).
 */

export type Health = 'ok' | 'waiting' | 'fire';
export const HEALTH_DOT: Record<Health, string> = { ok: '🟢', waiting: '🟠', fire: '🔴' };

export interface Issue {
  level: 'fire' | 'warn';
  title: string;
  detail: string;
  href?: string;
  /** Label for a button that opens `href` (otherwise the title itself links). */
  action?: string;
}

/**
 * Core issues (a data source that can't update) plus every `health-issues` slot item's, in slot order. An item that
 * throws is skipped. `items` defaults to the slot (pass a list to use it purely, e.g. in tests).
 */
export function collectIssues(sources: Record<string, SourceState>, items: Array<Pick<HealthIssuesItem, 'collect'>> = slotItems('health-issues')): Issue[] {
  const issues: Issue[] = [];
  for (const s of Object.values(sources)) {
    if (s.error) issues.push({ level: 'fire', title: `${s.title} can't update`, detail: s.error });
  }
  for (const item of items) {
    try {
      issues.push(...item.collect(sources));
    } catch (e) {
      console.error('health-issues:', e);
    }
  }
  return issues;
}

export function overallHealth(issues: Issue[], sessionsWaiting: number): Health {
  if (issues.some((i) => i.level === 'fire')) return 'fire';
  return sessionsWaiting > 0 ? 'waiting' : 'ok';
}
