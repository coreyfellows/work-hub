import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { asideInstruction, funReply, greeting, parseCast, pickHost, type ModHost } from './logic'

// work-hub's menagerie, terminal side: only what the Chat view relies on. At session start it reads the cast file
// work-hub generated (the path comes in WORK_HUB_MENAGERIE_CAST, set by the app's inline --settings), moves a host
// in with a greeting, has Claude sign off some replies in the host's voice, swaps Claude's spinner word for the
// host's, and answers /fun. With no cast file, or an empty one, it does nothing at all.

const hostId = atom({ plugin: 'work-hub-menagerie', key: 'host' } as const, null)

export const register: Register = on => {
  // Module variables start over on a hot reload; session.start runs again then.
  let hosts: ModHost[] = []
  let off = false
  let spinnerWord: string | undefined
  const rand = Math.random

  const byId = (id: string | null) => hosts.find(h => h.id === id)

  on('session.start', async ($, e, next) => {
    const file = await $.env.get('WORK_HUB_MENAGERIE_CAST')
    hosts = file ? parseCast(await $.fs.read(file).catch(() => '')) : []
    if (!hosts.length) return next(e)
    off = (await $.store.get('off')) === true

    await $.command.register({
      name: 'fun',
      description: 'The menagerie: list the cast, swap hosts, or turn the asides off and on',
      argumentHint: '[host <id> | off | on]',
    })

    // A reload keeps this session's host; only a new session moves someone in.
    if (!byId(await read($, hostId))) {
      const last = ((await $.store.get('last')) as string | undefined) ?? null
      const host = pickHost(hosts, last, rand)
      if (host) {
        await update($, hostId, () => host.id)
        await $.store.set('last', host.id)
        if (!off) await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: greeting(host) }] } }).catch(() => {})
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const host = hosts.length && !off && !e.isMeta ? byId(await read($, hostId)) : undefined
    spinnerWord = host?.spinner.length ? host.spinner[Math.floor(rand() * host.spinner.length)] : undefined
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (off || !hosts.length) return result
    const host = byId(await read($, hostId))
    if (!host) return result
    return { sections: [...result.sections, { id: 'menagerie:character', text: asideInstruction(host), scope: 'session' }] }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!spinnerWord || off) return next(e)
    return next({ ...e, props: { ...e.props, word: spinnerWord } })
  })

  on('command.run', { command: 'fun' }, async ($, e) => {
    const reply = funReply(e.args, hosts)
    if (reply.host) await update($, hostId, () => reply.host!.id)
    if (reply.off || reply.on) {
      off = !!reply.off
      await $.store.set('off', off)
    }
    return { text: reply.text }
  })
}
