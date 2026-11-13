import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { act, useState } from 'react'
import { Window } from 'happy-dom'
import type { BotModelMenu } from '../lib/bot-model-menu-view'

const initial: BotModelMenu = {
  current: { id: 'old', modelId: 'gpt-6-luna', provider: 'codex',
    kind: 'subscription', available: true, availability: 'available', chosen: true },
  groups: [
    { kind: 'subscription', provider: 'codex', options: [{ id: 'old', modelId: 'gpt-6-luna', provider: 'codex' }] },
    { kind: 'subscription', provider: 'claude', options: [{ id: 'haiku', modelId: 'claude-haiku-5-5', provider: 'claude' }] },
  ],
}
let chooseResult: Promise<BotModelMenu | { error: string }> = Promise.resolve(initial)
let refreshes = 0
let failures = 0
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
mock.module('sonner', { namedExports: { toast: { error: () => { failures++ } } } })
mock.module('swr', { defaultExport: function useFixtureSWR() {
  const [data, setData] = useState(initial)
  return { data, error: undefined, mutate: async (update: () => Promise<BotModelMenu>, options: {
    optimisticData?: BotModelMenu; rollbackOnError?: boolean
  } = {}) => {
    if (options.optimisticData) setData(options.optimisticData)
    try {
      const updated = await update()
      setData(updated)
      return updated
    } catch (error) {
      if (options.rollbackOnError) setData(initial)
      throw error
    }
  } }
} })
mock.module(new URL('../app/actions/execution-settings.ts', import.meta.url).href, { namedExports: {
  getBotModelMenu: async () => initial,
  chooseBotModel: async () => chooseResult,
  refreshBotModelMenuAction: async () => { refreshes++; return initial },
} })

const browser = new Window({ url: 'https://mikka.test/mikka' })
let createRoot: typeof import('react-dom/client')['createRoot']
let useBotModelPicker: typeof import('../hooks/use-bot-model-picker')['useBotModelPicker']
before(async () => {
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useBotModelPicker } = await import('../hooks/use-bot-model-picker'))
})

test('opening a cached picker does not refresh subscriptions, and an unsaved choice rolls back', async () => {
  let release!: (result: BotModelMenu | { error: string }) => void
  chooseResult = new Promise(resolve => { release = resolve })
  refreshes = 0
  failures = 0
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  let picker!: ReturnType<typeof useBotModelPicker>
  function Probe() { picker = useBotModelPicker(null); return null }
  try {
    await act(async () => { root.render(<Probe />) })
    await act(async () => { picker.setOpen(true) })
    assert.equal(picker.open, true)
    assert.equal(refreshes, 0, 'opening a menu cannot block on refreshing provider catalogues')
    let save!: Promise<boolean>
    await act(async () => { save = picker.choose('haiku') })
    assert.equal(picker.menu?.current.id, 'haiku', 'the selection is visible before server acknowledgement')
    assert.equal(picker.menu?.current.availability, 'checking')
    await act(async () => { release({ error: 'notSaved' }); await save })
    assert.equal(await save, false)
    assert.equal(picker.menu?.current.id, 'old', 'a failed save restores the confirmed model')
    assert.equal(failures, 1)
  } finally { await act(async () => root.unmount()) }
})
