import type { HistoryHost, TranscriptEnricher } from '../../plugin-api/server.ts';

/** The menagerie plugin's greeting (a system entry) and its `/fun host` reply (local command output). */
export const HOST_MARK = /^(?:<local-command-stdout>(?:work-hub-)?menagerie: )?\S+\s+(.+?) (?:has moved into your terminal|has taken over)\./;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Notes the latest greeting or `/fun host` swap as `{ name, at }` (`at` = the entry count when it was seen). `id` must be
 * the core's HOST_ENRICHER_ID: `readHistory` returns that enricher's `state.host` as the page's `host`.
 */
export function hostEnricher(id: string): TranscriptEnricher<{ host: HistoryHost | null }> {
  return {
    id,
    init: () => ({ host: null }),
    onRecord(rec, h) {
      if (!isObj(rec) || rec.isSidechain) return;
      if (typeof rec.content === 'string' && (rec.type === 'system' || rec.type === 'user')) {
        const m = HOST_MARK.exec(rec.content);
        if (m) h.state.host = { name: m[1]!, at: h.entries.length };
      }
      if (rec.type === 'user') {
        const content = (rec.message as { content?: unknown } | undefined)?.content;
        const m = typeof content === 'string' ? HOST_MARK.exec(content) : null;
        if (m) h.state.host = { name: m[1]!, at: h.entries.length };
      }
    },
  };
}
