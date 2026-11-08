import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginsWithSettings } from './pluginSettingsCommands.ts';

test('pluginsWithSettings: active plugins with declared settings or a section of their own', () => {
  const plugins = [
    { manifest: { id: 'github', title: 'GitHub' }, status: 'active' },
    { manifest: { id: 'notes', title: 'Notes' }, status: 'disabled' },
    { manifest: { id: 'auth', title: 'Auth' }, status: 'active' },
    { manifest: { id: 'menagerie', title: 'Menagerie' }, status: 'active' },
    { manifest: { id: 'tracker', title: 'Tracker' }, status: 'active' },
  ];
  const groups = [{ id: 'github' }, { id: 'notes' }, { id: 'health', builtin: true }];
  const sections = [{ plugin: 'menagerie' }, { plugin: 'tracker', scope: 'app' }];
  assert.deepEqual(pluginsWithSettings(plugins, groups, sections), [
    { id: 'github', title: 'GitHub' },
    { id: 'menagerie', title: 'Menagerie' },
  ]);
});
