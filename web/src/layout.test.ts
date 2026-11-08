import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { contribute, resetSlots } from './slots.ts';
import { sectionIds, tabIds, viewIds } from './layout.ts';

// The plugins' web.tsx files (JSX, DOM components) can't load in node, so their registrations of the default
// session views, workspace panels and Details sections are replayed here with stub components.
beforeEach(() => {
  resetSlots();
  const component = () => null;
  // The live-terminal plugin's Terminal view (plugins/live-terminal/web.tsx), registered with the same order.
  contribute('session-view', { plugin: 'live-terminal', id: 'terminal', label: 'Terminal', default: true, liveDot: true, order: 10, component });
  // The conversation-view plugin's views (plugins/conversation-view/web.tsx), registered with the same orders.
  contribute('session-view', { plugin: 'conversation-view', id: 'chat', label: 'Chat', default: true, needsHistory: true, readable: true, order: 20, component });
  contribute('session-view', { plugin: 'conversation-view', id: 'log', label: 'Log', needsHistory: true, order: 30, component });
  // The worktree-diff plugin's tab (plugins/worktree-diff/web.tsx), registered with the same order.
  contribute('workspace-panel', { plugin: 'worktree-diff', id: 'diff', label: 'Diff', order: 5, component });
  // The github plugin's Pull requests section (plugins/github/web.tsx), which keeps its old id and spot.
  contribute('workspace-section', { plugin: 'github', id: 'prs', title: 'Pull requests', order: 20, component });
});

test('default layout ids are what they were before the slots', () => {
  assert.deepEqual(tabIds(), ['details', 'diff']);
  assert.deepEqual(sectionIds(), ['links', 'prs', 'worktrees', 'notes', 'activity']);
  assert.deepEqual(viewIds(), ['terminal', 'chat', 'log']);
});

test('a plugin item with no order lands after the core and default plugin ones', () => {
  const component = () => null;
  contribute('workspace-panel', { plugin: 'x', id: 'extra', label: 'Extra', component });
  contribute('workspace-section', { plugin: 'x', id: 'extra', title: 'Extra', component });
  assert.deepEqual(tabIds(), ['details', 'diff', 'extra']);
  assert.deepEqual(sectionIds(), ['links', 'prs', 'worktrees', 'notes', 'activity', 'extra']);
});

test('the notes and code plugins put Note and Code after Diff, whatever order they load in (orders 101, 102)', () => {
  const component = () => null;
  contribute('workspace-panel', { plugin: 'code', id: 'code', label: 'Code', wide: true, order: 102, component });
  contribute('workspace-panel', { plugin: 'x', id: 'extra', label: 'Extra', component });
  contribute('workspace-panel', { plugin: 'notes', id: 'note', label: 'Note', wide: true, order: 101, component });
  assert.deepEqual(tabIds(), ['details', 'diff', 'extra', 'note', 'code']);
});
