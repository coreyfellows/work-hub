/**
 * Prompt fragments: text plugins add to the prompts the core writes for Claude sessions. The core appends
 * `workspace-rules` to the rules every workspace session gets (`workspaceRules`), `explorer` to the explorer's prompt
 * and `session-context` to the workspace context a new or review session starts with.
 */
export type PromptFragmentKind = 'workspace-rules' | 'explorer' | 'session-context' | 'app-rules';

/** What the prompt is being written for; fields depend on the kind (e.g. `workspaceId` for workspace rules). */
export interface PromptContext {
  workspaceId?: string;
  [key: string]: unknown;
}

export type PromptFragmentFn = (ctx: PromptContext) => string | null | undefined;

const registry: Array<{ kind: PromptFragmentKind; fn: PromptFragmentFn; owner: string }> = [];

/** `owner`: the plugin adding it, for `removeFragments`. */
export function addFragment(kind: PromptFragmentKind, fn: PromptFragmentFn, owner = 'core'): void {
  registry.push({ kind, fn, owner });
}

/** Drop every fragment `owner` added. */
export function removeFragments(owner: string): void {
  for (let i = registry.length - 1; i >= 0; i--) if (registry[i].owner === owner) registry.splice(i, 1);
}

/** Every fragment of `kind`, in registration order, joined with blank lines (empty ones dropped). */
export function fragments(kind: PromptFragmentKind, ctx: PromptContext = {}): string {
  return registry
    .filter((f) => f.kind === kind)
    .map((f) => {
      try {
        return f.fn(ctx)?.trim();
      } catch (e) {
        console.error(`prompt fragment (${f.kind}, ${f.owner}):`, e);
        return null;
      }
    })
    .filter((s): s is string => !!s)
    .join('\n\n');
}
