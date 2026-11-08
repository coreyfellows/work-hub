import type { WebPluginContext } from '../../plugin-api/web.ts';
import { hasGitCopy } from './gitCopies.ts';
import { WorktreeDiff } from './WorktreeDiff.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // Order 5: ahead of the core's Note and Code tabs, as Diff always was.
  ctx.contribute('workspace-panel', {
    id: 'diff',
    label: 'Diff',
    order: 5,
    available: hasGitCopy,
    component: ({ workspace, visible }) => <WorktreeDiff workspaceId={workspace.id} worktrees={workspace.worktrees.filter((t) => t.vcs === 'git')} active={visible} />,
  });
}
