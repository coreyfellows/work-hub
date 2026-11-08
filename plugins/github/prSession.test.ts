import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerPluginContext } from '../../plugin-api/server.ts';
import { promptFor } from './prSession.ts';
import { setSettings, type GithubSettings } from './settings.ts';

test('promptFor: the workspace context fragments (with the ticket key) come before the rules', () => {
  const seen: unknown[] = [];
  const ctx = {
    store: { getWorkspace: (id: string) => (id === 'ws-1' ? { ticketKey: 'ABC-123' } : null) },
    prompts: {
      workspaceRules: () => ['RULE ONE'],
      fragments: (kind: string, c: unknown) => {
        seen.push([kind, c]);
        return kind === 'session-context' ? 'CONTEXT BLOCK' : '';
      },
    },
  } as unknown as ServerPluginContext;
  setSettings({ ctx } as GithubSettings);
  const p = promptFor({ url: 'https://gh/o/r/pull/1', title: 'T', repo: 'o/r', branch: 'b', number: 1, mine: true }, 'ws-1');
  assert.deepEqual(seen, [['session-context', { workspaceId: 'ws-1', ticketKey: 'ABC-123' }]]);
  assert.ok(p.indexOf('CONTEXT BLOCK') > 0 && p.indexOf('CONTEXT BLOCK') < p.indexOf('RULE ONE'), p);
});
