/** Where a workspace's note is (`GET /api/plugins/notes/workspaces/:id`, `POST /api/workspaces/:id/note`). */
export interface NoteInfo {
  /** SilverBullet page name, e.g. "tickets/TKT-14393" */
  page: string;
  path: string;
  url: string;
  exists: boolean;
}
