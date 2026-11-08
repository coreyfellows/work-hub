import { EventEmitter } from 'node:events';

/**
 * In-process events the core and plugins can listen to. The core emits: `workspace-event` (every `logEvent`),
 * `session-started` / `session-stopped` (lib/sessions.ts), `source-changed` (registry.ts, whenever a source's state
 * changes) and `job-finished` (jobs.ts). A plugin can declare more names by merging into `HubEvents` (`declare module`),
 * or just use any string.
 */
export interface HubEvents {
  'workspace-event': { workspaceId: string; type: string; detail: string | null; sessionId: string | null };
  'session-started': { shortId: string; sessionId: string; cwd: string; name: string; purpose: string };
  'session-stopped': { shortId: string; sessionId?: string };
  'source-changed': { id: string };
  'job-finished': { id: string; kind: string; status: 'done' | 'failed' };
  [name: string]: unknown;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const hubEvents = {
  /** Listen for an event; a listener that throws is logged and never breaks the emitter or other listeners. Returns an unsubscribe. */
  on<K extends keyof HubEvents & string>(name: K, fn: (payload: HubEvents[K]) => void | Promise<void>): () => void {
    const wrapped = (payload: HubEvents[K]) => {
      try {
        const r = fn(payload);
        if (r instanceof Promise) r.catch((e: unknown) => console.error(`event ${name} listener:`, e));
      } catch (e) {
        console.error(`event ${name} listener:`, e);
      }
    };
    emitter.on(name, wrapped);
    return () => void emitter.off(name, wrapped);
  },
  emit<K extends keyof HubEvents & string>(name: K, payload: HubEvents[K]): void {
    emitter.emit(name, payload);
  },
};
