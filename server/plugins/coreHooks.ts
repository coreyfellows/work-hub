/**
 * The core registries plugins register into, bundled for `createServerContext` (`ContextDeps.hooks`). Every
 * registration carries the plugin id, so the loader can take back everything a plugin registered if its `register()`
 * throws half-way (`removeByPlugin`). Routes it already added can't be removed.
 */
import { addFileRoot, fileRoots, removeFileRoots } from '../lib/fileRoots.ts';
import { addFragment, removeFragments } from '../lib/prompts.ts';
import { addLaunchArgs, removeLaunchArgs } from '../lib/sessions.ts';
import { registerUrgent, removeUrgent } from '../lib/sourceDelta.ts';
import { addEnricher, removeEnrichers } from '../lib/transcript.ts';
import { addReconcilePass, removeReconcilePasses } from '../reconcile.ts';
import { hideSession, removeHidePredicates } from '../sources/claude.ts';
import type { CoreHooks } from './context.ts';

export const coreHooks: CoreHooks = {
  addEnricher: (e, plugin) => addEnricher(e, plugin),
  addLaunchArgs: (fn, plugin) => addLaunchArgs(fn, plugin),
  addReconcilePass: (fn, plugin) => addReconcilePass(fn, plugin),
  hideSession: (pred, plugin) => hideSession(pred, plugin),
  registerUrgent: (sourceId, listKey, fields, plugin) => registerUrgent(sourceId, listKey, fields, plugin),
  addFragment: (kind, fn, plugin) => addFragment(kind, fn, plugin),
  addFileRoot: (dir, plugin) => addFileRoot(dir, plugin),
  fileRoots: () => fileRoots(),
  removeByPlugin(plugin) {
    removeEnrichers(plugin);
    removeLaunchArgs(plugin);
    removeReconcilePasses(plugin);
    removeHidePredicates(plugin);
    removeUrgent(plugin);
    removeFragments(plugin);
    removeFileRoots(plugin);
  },
};
