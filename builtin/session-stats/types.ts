export interface SessionStats {
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** API-equivalent cost of the responses with a known model price; null if none are priced. */
  costUsd: number | null;
  unpricedModels: string[];
  responses: number;
  files: Array<{ path: string; edits: number; lastAt: string | null; wrote: boolean }>;
}
