import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import React, { act } from 'react'
import useSWR, { SWRConfig } from 'swr'
import { Window } from 'happy-dom'
import { botKeys } from '@/lib/swr/keys'
import type { BotView } from '@/app/actions/bots'

const original: BotView = { id: 'editor', name: 'Editor', color: 'red', shape: 'circle' }
let stored = original
let denied = false
let writes = 0
mock.module(new URL('../../app/actions/bots.ts', import.meta.url).href, { namedExports: {
  updateBot: async ({ name }: { name: string }) => {
    writes++
    if (denied) return { error: 'botNotFound' }
    stored = { ...stored, name }
    return stored
  },
} })

const browser = new Window({ url: 'https://fixture.example' })
let createRoot: typeof import('react-dom/client')['createRoot']
let useSaveBot: typeof import('./use-save-bot')['useSaveBot']

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useSaveBot } = await import('./use-save-bot'))
})
after(() => browser.happyDOM.close())

test('a Bot edit updates its workspace roster and existing pickers after one write, even without a live push', async () => {
  const container = document.body
  const root = createRoot(container)
  let save!: ReturnType<typeof useSaveBot>
  function Consumers() {
    save = useSaveBot()
    const picker = useSWR(botKeys.all(), async () => [stored])
    const roster = useSWR(botKeys.list('owner', 'workspace'), async () => ({ items: [stored], live: { ownerId: 'owner', workspaceId: 'workspace' } }))
    const settings = useSWR(['bots', 'workspace', 'workspace'], async () => [stored])
    return <>{[roster.data?.items[0]?.name, picker.data?.[0]?.name, settings.data?.[0]?.name].join(' / ')}</>
  }
  try {
    await act(async () => root.render(<SWRConfig value={{ provider: () => new Map() }}><Consumers /></SWRConfig>))
    assert.equal(container.textContent, 'Editor / Editor / Editor')
    await act(async () => { await save('editor', { name: 'Builder' }) })
    assert.equal(writes, 1)
    assert.equal(container.textContent, 'Builder / Builder / Builder')
    denied = true
    await act(async () => { await assert.rejects(save('editor', { name: 'Denied' }), /botNotFound/) })
    assert.equal(writes, 2)
    assert.equal(container.textContent, 'Builder / Builder / Builder')
  } finally {
    await act(async () => root.unmount())
  }
})
