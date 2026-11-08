// The slim mod's pure parts (no engine calls), tested from work-hub (plugins/menagerie/mod.test.ts).
//
// The strings below are read back by work-hub: HOST_MARK (plugins/menagerie/hostEnricher.ts) matches the greeting
// and the swap reply, and splitAside matches the `> <emoji> *text*` aside on the last line of a reply. Change them
// together or not at all.

export type ModHost = {
  id: string
  name: string
  emoji: string
  voice: string
  spinner: string[]
  rare?: boolean
}

/** How often a rare host (the moth) moves in instead of a regular one. */
export const RARE_ODDS = 0.05

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The hosts in the cast file's text; anything unreadable is skipped, bad JSON is no hosts at all. */
export function parseCast(text: string): ModHost[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list = (raw as { characters?: unknown } | null)?.characters
  if (!Array.isArray(list)) return []
  // The same basic rules as work-hub's validator (plugins/menagerie/cast.ts), so a hand-edited file can't give a
  // session a host the app doesn't know, or an unbounded voice.
  const out: ModHost[] = []
  for (const c of list as Record<string, unknown>[]) {
    if (!c || !isStr(c.id) || !isStr(c.name) || !isStr(c.emoji) || !isStr(c.voice)) continue
    if (!/^[a-z0-9-]{1,24}$/.test(c.id) || c.name.length > 40 || c.voice.length > 600 || c.emoji.length > 16) continue
    if (out.some(h => h.id === c.id || h.emoji === c.emoji)) continue
    const spinner = Array.isArray(c.spinner) ? (c.spinner as unknown[]).filter(isStr) : []
    out.push({ id: c.id, name: c.name, emoji: c.emoji, voice: c.voice, spinner, ...(c.rare === true ? { rare: true } : {}) })
  }
  return out
}

/** This session's host: a rare one about 1 time in 20, else a regular one other than last session's (when possible). */
export function pickHost(hosts: ModHost[], last: string | null, rand: () => number): ModHost | null {
  if (!hosts.length) return null
  const rare = hosts.filter(h => h.rare)
  const regular = hosts.filter(h => !h.rare)
  const any = (list: ModHost[]) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))]!
  if (rare.length && (!regular.length || rand() < RARE_ODDS)) return any(rare)
  const fresh = regular.filter(h => h.id !== last)
  return any(fresh.length ? fresh : regular)
}

export const greeting = (h: ModHost) => `${h.emoji}  ${h.name} has moved into your terminal.`
export const tookOver = (h: ModHost) => `${h.emoji} ${h.name} has taken over.`

/** The prompt section that has Claude sign off some replies in the host's voice. */
export const asideInstruction = (h: ModHost) =>
  [
    '# The resident character',
    `This session, ${h.name} lives in the user's terminal: ${h.voice}`,
    `In roughly one in three of your final chat replies to the user in the main conversation, end with ONE short absurd aside in ${h.name}'s voice reacting to what just happened, as the very last line, formatted exactly: \`> ${h.emoji} *the aside*\`. Keep it under 25 words. Make it specific to the moment, surprising, and never corporate or try-hard.`,
    'Never put the character, its voice or its asides anywhere else: not in code, files, commit messages, PR or Jira or Slack text, tool inputs, plans, or questions. Skip the aside when the reply delivers bad news that needs care, and when you are a subagent.',
  ].join('\n')

const roster = (hosts: ModHost[]) => hosts.map(h => `${h.emoji} ${h.id}`).join(', ')

/** What `/fun <args>` answers, and what it changes. */
export function funReply(args: string, hosts: ModHost[]): { text: string; host?: ModHost; off?: boolean; on?: boolean } {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').toLowerCase()
  if (verb === 'host') {
    const host = hosts.find(h => h.id === arg || h.name.toLowerCase() === arg)
    return host ? { text: tookOver(host), host } : { text: `Who? The residents are: ${roster(hosts)}` }
  }
  if (verb === 'off') return { text: 'The menagerie has gone quiet: no more asides. (/fun on to bring them back)', off: true }
  if (verb === 'on') return { text: 'The menagerie is back: asides now and then.', on: true }
  return {
    text: [`The residents: ${roster(hosts)}`, '/fun host <id>   swap hosts', '/fun off | on    stop or bring back the asides', 'Edit the cast in work-hub: Settings → Plugins → Menagerie.'].join('\n'),
  }
}
