import type { Block } from '../../digest.ts';

export function seenDiff(seenVersions: Record<string, string> | null | undefined, blocks: Block[], selfSessionId: string): { changed: Block[]; gone: string[] };

export function changeLines(
  prevBlocks: Block[] | null,
  nextBlocks: Block[],
  self: { sessionId: string; shortId: string },
  opts?: { stale?: boolean; liveAt?: number | null; now?: number; max?: number },
): string[];
