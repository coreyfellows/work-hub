import { join } from 'node:path';
import type { HistoryEntry, ServerPluginContext, TranscriptEnricher } from '../../../plugin-api/server.ts';
import { bashEdits } from './bashEdits.ts';
import { launchArgs } from './hookSettings.ts';
import { readGlobalHook, userSettingsPath, type GlobalHook } from './globalHook.ts';

/** How long after a Bash call to keep waiting for its after-snapshot (the hook may never run, e.g. interrupted). */
const SNAP_WAIT_MS = 60_000;

export default function register(ctx: ServerPluginContext): void {
  // Must match where the hook writes: the hook is given this same folder (WORK_HUB_BASH_SNAP_DIR) when the app starts a session.
  const snapDir = ctx.config.get('bashSnapshotsDir', process.env.WORK_HUB_BASH_SNAP_DIR ?? join(ctx.paths.stateDir, 'bash-snaps'));
  const hookPath = join(ctx.pluginDir, 'bash-snapshots', 'claude', 'hooks', 'bash-snapshot.sh');

  const enricher: TranscriptEnricher<{ pending: Map<string, HistoryEntry> }> = {
    id: 'bash-edits',
    init: () => ({ pending: new Map() }),
    onToolUse(entry, tool, state) {
      if (tool.name === 'Bash' && entry.id) state.pending.set(entry.id, entry);
    },
    /** Attaches the file changes of finished Bash calls (once each; they're looked up when the call's result is in). */
    async resolve(sessionId, _entries, state) {
      const ready = [...state.pending].filter(([, e]) => e.result !== undefined);
      if (!ready.length) return false;
      for (const [id] of ready) state.pending.delete(id); // claimed, so a concurrent load doesn't attach them twice
      let added = false;
      for (let k = 0; k < ready.length; k += 32) {
        await Promise.all(
          ready.slice(k, k + 32).map(async ([id, e]) => {
            const edits = await bashEdits(snapDir, sessionId, id, e.at).catch(() => []);
            if (edits === null) {
              if (Date.now() - Date.parse(e.at ?? '') < SNAP_WAIT_MS) state.pending.set(id, e);
              return;
            }
            if (edits.length) {
              e.edits = edits;
              added = true;
            }
          }),
        );
      }
      return added;
    },
  };
  ctx.transcript.addEnricher(enricher);

  // Sessions the app starts get the hook for that session only; nothing is written to the user's Claude settings.
  // If the user registered the hook in their own settings (README option 2) and it writes to this same folder, it
  // already runs in those sessions: adding ours would run it twice per Bash call, racing on the same files. The
  // settings file is only read, at every launch, so installing or removing the global hook needs no restart.
  const settingsPath = ctx.config.get('bashSnapshotsClaudeSettings', userSettingsPath());
  let lastKind: GlobalHook['kind'] | undefined;
  ctx.sessions.addLaunchArgs(async () => {
    const global = await readGlobalHook(settingsPath, snapDir);
    if (global.kind !== lastKind) {
      lastKind = global.kind;
      if (global.kind === 'same') ctx.log.info(`snapshot hook: using the global hook in ${settingsPath} (writes to ${snapDir}); no per-session hook`);
      else if (global.kind === 'elsewhere')
        ctx.log.warn(`snapshot hook: the global hook in ${settingsPath} writes to ${global.dir}, not ${snapDir}; adding the per-session hook too (both run, in different folders)`);
      else ctx.log.info(`snapshot hook: per-session (--settings) for sessions the app starts; snapshots in ${snapDir}`);
    }
    return global.kind === 'same' ? [] : launchArgs(hookPath, snapDir);
  });
}
