import type { FileEdit, TranscriptEnricher } from '../../../plugin-api/server.ts';

/** How much of an edit's text (each hunk side, or a written file) an entry carries. */
const EDIT_CAP = 6000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The change an Edit/MultiEdit/Write/NotebookEdit call makes, from its input (undefined for other tools). */
export function recordEdit(tool: string, input: Record<string, unknown>, at: string | null): FileEdit | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (!path) return undefined;
  const s = (v: unknown) => (typeof v === 'string' ? clip(v, EDIT_CAP) : '');
  if (tool === 'Edit') return { path, tool, at, hunks: [{ old: s(input.old_string), new: s(input.new_string) }] };
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return { path, tool, at, hunks: (input.edits as Array<Record<string, unknown>>).map((e) => ({ old: s(e.old_string), new: s(e.new_string) })) };
  }
  if (tool === 'Write' && typeof input.content === 'string') return { path, tool, at, content: clip(input.content, EDIT_CAP), lines: input.content.split('\n').length };
  if (tool === 'NotebookEdit') return { path, tool, at, hunks: [{ old: '', new: s(input.new_source) }] };
  return undefined;
}

/** `edit` on edit-tool entries; `edit.created` once a Write's result says it made a new file. */
export const editEnricher: TranscriptEnricher = {
  id: 'edits',
  onToolUse(entry, tool) {
    const edit = recordEdit(tool.name, (tool.input ?? {}) as Record<string, unknown>, entry.at);
    return edit ? { edit } : undefined;
  },
  onToolResult(entry, result) {
    // A Write that made a new file is shown as the file, not a diff.
    if (entry.edit?.tool === 'Write') entry.edit.created = /^File created/.test(result.text);
  },
};
