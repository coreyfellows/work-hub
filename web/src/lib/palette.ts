/** The palette listens for this to open; `detail.query` (optional) prefills it, e.g. ">" for command mode. */
export const OPEN_PALETTE_EVENT = 'wh:open-palette';

/** Open the ⌘K palette, optionally prefilled (`openPalette('>')` opens it on the commands). */
export function openPalette(query = ''): void {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { query } }));
}

/** A query starting with `>` lists commands (what follows filters them); anything else jumps to places. */
export function paletteMode(query: string): { commands: boolean; filter: string } {
  const t = query.trimStart();
  return t.startsWith('>') ? { commands: true, filter: t.slice(1).trim() } : { commands: false, filter: query };
}

interface WorkspaceLike {
  id: string;
  sessions: Array<{ claudeSessionId: string; shortId?: string | null }>;
}

/** The workspace and session a path is about: `/workspaces/:id`, or `/sessions/:id` (and the workspace that owns it). */
export function paletteContext(path: string, workspaces: WorkspaceLike[]): { workspaceId: string | null; sessionId: string | null } {
  const [a, b, ...rest] = path.split('/').filter(Boolean);
  if (!b || rest.length) return { workspaceId: null, sessionId: null };
  const id = decodeURIComponent(b);
  if (a === 'workspaces' && id !== 'new') return { workspaceId: id, sessionId: null };
  if (a !== 'sessions') return { workspaceId: null, sessionId: null };
  const owner = workspaces.find((w) => w.sessions.some((r) => r.claudeSessionId === id || r.shortId === id));
  return { workspaceId: owner?.id ?? null, sessionId: id };
}

/** Where a keypress is text for something else (an input, a textarea, an editable element, a terminal). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return !!h.closest?.('.xterm') || h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || !!h.isContentEditable;
}
