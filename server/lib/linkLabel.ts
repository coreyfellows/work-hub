/**
 * The detail of a `link` event: `repo#12` for a PR URL, else the URL. Same spelling as the github plugin's reconcile
 * pass (`prLabel` in plugins/github/prLinks.ts; copied because the core can't import a plugin).
 */
export function linkLabel(url: string): string {
  const m = url.match(/\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/);
  return m ? `${m[1]}#${m[2]}` : url;
}
