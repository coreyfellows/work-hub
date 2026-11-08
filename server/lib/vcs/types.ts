/**
 * A source-control provider: how the core finds, names, inspects and removes one kind of working copy (a git worktree,
 * a jj workspace, a plain folder…). The core's git and folder providers live beside this file; others come from plugins
 * (`ctx.vcs.register`). Types are re-exported from `plugin-api/server.ts`.
 */

/** What removing a working copy would cost. */
export interface WorkingCopyState {
  exists: boolean;
  /** Uncommitted (unsaved to the VCS) changes. */
  dirty: boolean;
  /** Work recorded locally but nowhere else (git: commits on no other branch or remote). */
  unsaved: number;
  /** `block === null`. */
  removable: boolean;
  /** Why it can't be removed without `force` (or at all), or null. */
  block: string | null;
}

/** What a provider's prompt text may mention. */
export interface AgentInstructionOpts {
  workspaceId: string;
  ticketKey: string | null;
  /** The `wh` command, shell-quoted. */
  whCommand: string;
  worktreesDir: string;
}

export interface SourceControlProvider {
  id: string;
  title: string;
  experimental?: boolean;
  /** The root of the working copy of this kind that `path` is in, or null. */
  detect(path: string): Promise<string | null>;
  /** A repo id for display and matching (git: `owner/name` from origin), or null. */
  identity(root: string): Promise<{ repo: string | null }>;
  /** The current line of work (branch, bookmark, changelist…) and a head id. */
  line(root: string): Promise<{ line: string | null; head: string | null }>;
  /** Lines too generic to tie a session to a workspace by name alone. */
  sharedLines: ReadonlySet<string>;
  inspect(root: string): Promise<WorkingCopyState>;
  /** Remove the working copy (keeping its line). Throws when it can't be removed (see `inspect().block`). */
  removeWorkingCopy(root: string, opts: { force: boolean }): Promise<void>;
  /** Prompt lines telling Claude how to make and record a working copy of this kind for a workspace. */
  agentInstructions(o: AgentInstructionOpts): string[];
  /** Whether its CLI is there (Status page, setup). */
  prereq(): Promise<{ ok: boolean; detail: string }>;
}
