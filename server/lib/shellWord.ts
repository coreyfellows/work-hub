/** `s` as one shell word: as is when it's only safe characters (keeps prompts readable), else single-quoted. */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
