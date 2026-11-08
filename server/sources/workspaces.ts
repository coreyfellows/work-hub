import type { Source } from '../registry.ts';
import { listWorkspaces, type Workspace } from '../store/workspaces.ts';

/** The explicit workspace model from SQLite. Cheap to read, so it polls often (still only while watched). */
export interface WorkspacesData {
  workspaces: Workspace[];
}

export const workspacesSource: Source<WorkspacesData> = {
  id: 'workspaces',
  title: 'Workspaces',
  intervalMs: 3_000,
  local: true,
  // Done workspaces are included so the UI can list and reopen them.
  fetch: async () => ({ workspaces: listWorkspaces({ includeDone: true }) }),
};
