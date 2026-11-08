import type { DatabaseSync } from 'node:sqlite';
import type { Job, JobsStore } from '../jobs.ts';
import { getDb } from './db.ts';

/** SQLite backing for server/jobs.ts (migration 9). */
export function sqliteJobsStore(db: () => DatabaseSync = getDb): JobsStore {
  return {
    load() {
      const rows = db().prepare('SELECT * FROM jobs ORDER BY started_at').all() as Array<Record<string, string | number | null>>;
      return rows.map((r) => ({
        payload: r.payload ? (JSON.parse(String(r.payload)) as unknown) : null,
        job: ((): Job => ({
          id: String(r.id),
          kind: r.kind as Job['kind'],
          title: String(r.title),
          detail: (r.detail as string | null) ?? null,
          workspaceId: (r.workspace_id as string | null) ?? null,
          status: r.status as Job['status'],
          startedAt: Number(r.started_at),
          finishedAt: r.finished_at === null ? null : Number(r.finished_at),
          error: (r.error as string | null) ?? null,
          link: r.link_to ? { to: String(r.link_to), label: String(r.link_label ?? '') } : null,
        }))(),
      }));
    },
    save(j, payload) {
      db()
        .prepare(
          `INSERT INTO jobs (id, kind, title, detail, workspace_id, status, started_at, finished_at, error, link_to, link_label, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, status = excluded.status, finished_at = excluded.finished_at,
             error = excluded.error, link_to = excluded.link_to, link_label = excluded.link_label, title = excluded.title,
             payload = excluded.payload`,
        )
        .run(j.id, j.kind, j.title, j.detail, j.workspaceId, j.status, j.startedAt, j.finishedAt, j.error, j.link?.to ?? null, j.link?.label ?? null, payload === null || payload === undefined ? null : JSON.stringify(payload));
    },
    remove(id) {
      db().prepare('DELETE FROM jobs WHERE id = ?').run(id);
    },
  };
}
