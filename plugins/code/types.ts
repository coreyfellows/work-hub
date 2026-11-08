/** A VS Code (serve-web) link for one of a workspace's worktrees (`GET /api/plugins/code/workspaces/:id`). */
export interface CodeLink {
  label: string;
  path: string;
  url: string;
}
