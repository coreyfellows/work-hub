import { useEffect, useRef } from 'react';
import type { PaletteCommand } from '../../../plugin-api/web.ts';
import type { MenuItem } from '../components/Menu.tsx';

/**
 * Commands offered by what's on screen (the session you're looking at, the workspace page), on top of the
 * `palette-commands` slot: a component registers them with `usePaletteCommands` while it's mounted. Read when the palette
 * renders, so each registration hands over its latest list (fresh closures) without any subscription.
 */
const mounted = new Map<object, () => PaletteCommand[]>();

export function usePaletteCommands(list: PaletteCommand[] | null): void {
  const ref = useRef(list);
  ref.current = list;
  useEffect(() => {
    const key = {};
    mounted.set(key, () => ref.current ?? []);
    return () => {
      mounted.delete(key);
    };
  }, []);
}

/** Every mounted component's commands; on an id clash the one mounted last wins (the view you opened most recently). */
export function mountedCommands(): PaletteCommand[] {
  return dedupeLast([...mounted.values()].flatMap((f) => f()));
}

/** Keeps the last command of each id, in the order the survivors first appeared. */
export function dedupeLast(list: PaletteCommand[]): PaletteCommand[] {
  const last = new Map<string, PaletteCommand>();
  for (const c of list) last.set(c.id, c);
  const seen = new Set<string>();
  const out: PaletteCommand[] = [];
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(last.get(c.id)!);
  }
  return out;
}

/**
 * A menu's items as commands: separators, hidden and disabled items (and `palette: false` ones) are left out, a submenu's items become
 * "<item> › <sub-item>". Ids are `<prefix>:<label path>`, so the same menu in another view replaces these.
 */
export function menuCommands(items: MenuItem[], opts: { prefix: string; group: string; hint?: string }): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  const walk = (list: MenuItem[], path: string[]) => {
    for (const it of list) {
      if (it === 'separator' || it.hidden || it.disabled || it.palette === false) continue;
      const labels = [...path, it.label];
      if (it.submenu) walk(it.submenu, labels);
      else if (it.onSelect) {
        const run = it.onSelect;
        out.push({ id: `${opts.prefix}:${labels.join('/')}`, label: labels.join(' › '), group: opts.group, hint: opts.hint, run: () => run() });
      }
    }
  };
  walk(items, []);
  return out;
}
