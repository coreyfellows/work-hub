import { getDb } from './db.ts';

/**
 * The right-hand panel's arrangement, one for every workspace and device: the order of its top tabs and of the
 * Details sections. Only ids are stored; the UI ignores ones it doesn't know and puts new ones at their default spot.
 */
export interface UiLayout {
  tabs: string[];
  sections: string[];
  /** The session view tabs (Terminal, Chat, Log). */
  views: string[];
  /** Per workspace: the order of its session and terminal tabs (ids as the UI names them). */
  items: Record<string, string[]>;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX = 20;
const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;
const WS_ID = /^[A-Za-z0-9_.-]{1,64}$/;


function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && ID.test(x) && !out.includes(x)) out.push(x);
  return out.slice(0, MAX);
}

function items(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [ws, list] of Object.entries(v as Record<string, unknown>)) {
    if (!WS_ID.test(ws) || !Array.isArray(list) || Object.keys(out).length >= 200) continue;
    const clean: string[] = [];
    for (const x of list) if (typeof x === 'string' && ITEM_ID.test(x) && !clean.includes(x)) clean.push(x);
    if (clean.length) out[ws] = clean.slice(0, 50);
  }
  return out;
}

export function cleanLayout(v: unknown): UiLayout {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { tabs: ids(o.tabs), sections: ids(o.sections), views: ids(o.views), items: items(o.items) };
}

export function getLayout(): UiLayout {
  const row = getDb().prepare("SELECT value FROM ui_prefs WHERE key = 'layout'").get() as { value: string } | undefined;
  if (!row) return cleanLayout({});
  try {
    return cleanLayout(JSON.parse(row.value));
  } catch {
    return cleanLayout({});
  }
}

export function setLayout(v: unknown): UiLayout {
  const layout = cleanLayout(v);
  getDb().prepare("INSERT INTO ui_prefs (key, value) VALUES ('layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(layout));
  return layout;
}
