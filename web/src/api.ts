import { useEffect, useState } from 'react';
import { useLowData } from './lowData.ts';
import type { HubStatus, SourceState } from '../../server/registry.ts';
import { applyPatch, type SourcePatch } from '../../server/lib/sourceDelta.ts';

export type { HubStatus, SourceState };
export type { ClaudeData, Session } from '../../server/sources/claude.ts';
export type { WorkspacesData } from '../../server/sources/workspaces.ts';
export type { Job } from '../../server/jobs.ts';
export type { JobsData } from '../../server/sources/jobs.ts';
export type { FileEdit, HistoryEntry } from '../../server/lib/transcript.ts';
export type { Workspace, WorkspaceStatus } from '../../server/store/workspaces.ts';

/** Text typed into a box, or a dialog open: reloading now would lose it. */
function unsavedWork(): boolean {
  if (document.querySelector('dialog[open]')) return true;
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type="text"], input:not([type])')].some(
    (el) => el.value.trim() !== '',
  );
}

/**
 * Live map of every source's state plus the hub's activity status, kept current over SSE.
 * The connection is held only while the tab is visible: the server polls (and spends tokens)
 * only while some visible tab is connected, so a hidden tab costs nothing.
 */
export function useSources(): { sources: Record<string, SourceState>; connected: boolean; status: HubStatus | null; newBuild: boolean } {
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<HubStatus | null>(null);
  const lowData = useLowData();
  const [newBuild, setNewBuild] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      if (es || document.hidden) return;
      // Low data: the server batches non-urgent changes (urgent ones still come at once).
      es = new EventSource(lowData ? '/api/events?low=1' : '/api/events');
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        if (es?.readyState === EventSource.CLOSED) {
          // Closed for good (e.g. 401). Check auth, then retry.
          es = null;
          void fetch('/api/status').then((r) => {
            if (r.status === 401) location.href = '/login';
            else retry = setTimeout(open, 3000);
          });
        }
      };
      es.addEventListener('source', (e) => {
        const s = JSON.parse((e as MessageEvent).data) as SourceState;
        setSources((prev) => ({ ...prev, [s.id]: s }));
      });
      // After a source's first full state, the server sends only what changed.
      es.addEventListener('source-patch', (e) => {
        const p = JSON.parse((e as MessageEvent).data) as SourcePatch;
        setSources((prev) => (prev[p.id] ? { ...prev, [p.id]: applyPatch(prev[p.id], p) } : prev));
      });
      // A deploy shipped a new UI: reload, unless that would lose something you're typing or have open
      // (then the header offers it).
      es.addEventListener('build', (e) => {
        const id = (e as MessageEvent).data as string;
        if (__WH_BUILD__ === 'dev' || id === __WH_BUILD__) return;
        if (unsavedWork()) setNewBuild(true);
        else location.reload();
      });
      es.addEventListener('status', (e) => setStatus(JSON.parse((e as MessageEvent).data) as HubStatus));
    };
    const close = () => {
      clearTimeout(retry);
      es?.close();
      es = null;
      setConnected(false);
    };
    const onVisibility = () => (document.hidden ? close() : open());

    open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [lowData]); // toggling low data reopens the stream with or without ?low=1

  return { sources, connected, status, newBuild };
}

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export function ago(ts: number | string | null | undefined): string {
  if (ts == null) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

