/**
 * Finding the script behind a `!` command (pure, so the browser can use `commandCandidates` to decide whether to offer
 * "View script"; the server reads the file only from `insideRoots` places).
 */

const SCRIPT_EXT = /\.(sh|bash|zsh|py|ts|js|mjs|cjs|rb)$/;

/** Split like a shell would, minimally: whitespace separates, single and double quotes group, backslash escapes. */
function tokens(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Path-like tokens of the command that could be a script file (flags and `--opt=value` skipped), at most 4, in order. */
export function commandCandidates(command: string): string[] {
  const out: string[] = [];
  for (const t of tokens(command).slice(0, 8)) {
    if (t.startsWith('-') || t.includes('=') && !t.startsWith('/') && !t.startsWith('~')) continue;
    if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.startsWith('../') || SCRIPT_EXT.test(t)) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

/** Is `path` one of `roots` or somewhere under one (no `..` tricks: pass an already-resolved path)? */
export function insideRoots(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`));
}
