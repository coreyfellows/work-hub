import { useState, type ReactNode } from 'react';
import type { MenuActionItem } from '../../../plugin-api/web.ts';
import { useSlotOnce } from '../slots.ts';
import { Menu, type MenuItem } from './Menu.tsx';
import { menuCommands, usePaletteCommands } from '../lib/paletteStore.ts';

type ActionSlot = 'workspace-action' | 'session-action' | 'tabstrip-action';

/**
 * A core menu (`base` items) with an action slot's items appended. Each item's `useItem` runs here as a hook (the slot is
 * read once when this mounts); an item with a `dialog` opens it when selected. Draws nothing when no item is visible.
 * With `palette`, its items are also commands in the palette's command mode (`>`) while it's mounted.
 */
export function ActionMenu<C extends object>({
  slot,
  ctx,
  base,
  trigger,
  ariaLabel,
  align,
  className,
  palette,
}: {
  slot: ActionSlot;
  ctx: C;
  base: MenuItem[];
  trigger: ReactNode;
  ariaLabel: string;
  align?: 'left' | 'right';
  className?: string;
  palette?: { group: string; hint?: string };
}) {
  const actions = useSlotOnce(slot) as unknown as MenuActionItem<C>[];
  const [open, setOpen] = useState<string | null>(null);
  const extra: MenuItem[] = [];
  for (const a of actions) {
    const item = a.useItem(ctx);
    if (!item) continue;
    if (item === 'separator' || !a.dialog) extra.push(item);
    else
      extra.push({
        ...item,
        onSelect: () => {
          item.onSelect?.();
          setOpen(a.id);
        },
      });
  }
  const items = [...base, ...extra];
  usePaletteCommands(palette ? menuCommands(items, { prefix: slot, ...palette }) : null);
  const visible = items.some((i) => i !== 'separator' && !i.hidden);
  const Dialog = open ? actions.find((a) => a.id === open)?.dialog : undefined;
  return (
    <>
      {visible && <Menu ariaLabel={ariaLabel} align={align} trigger={trigger} items={items} className={className} />}
      {Dialog && <Dialog {...ctx} onClose={() => setOpen(null)} />}
    </>
  );
}
