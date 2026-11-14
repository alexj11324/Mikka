import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'

test('Telegram settings withdraw unavailable status and retry the original account read', async () => {
  const window = new Window({ url: 'https://mikka.test' })
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
  let attempts = 0
  const read = mock.fn(async () => {
    if (++attempts === 1) throw new Error('status unavailable')
    return { configured: true, connected: true, telegramUserName: 'accepted', linkedAt: null }
  })
  mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
  mock.module('@/app/actions/telegram', { namedExports: {
    getTelegramIntegrationStatus: read, createTelegramConnectLink: mock.fn(), disconnectTelegram: mock.fn(),
  } })
  const { createRoot } = await import('react-dom/client')
  const { TelegramSettings } = await import('./telegram-settings')
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<TelegramSettings />))
    const retry = [...container.querySelectorAll('button')].find(item => item.textContent === 'retry')
    assert.ok(retry)
    assert.ok(container.textContent?.includes('error'))
    assert.ok(!container.textContent?.includes('loading'))
    assert.ok(!container.textContent?.includes('disconnect'))
    await act(async () => retry.click())
    assert.equal(read.mock.callCount(), 2)
    assert.ok(container.textContent?.includes('@accepted'))
    assert.ok(!container.textContent?.includes('retry'))
    assert.ok(!container.textContent?.includes('error'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
    mock.restoreAll()
  }
})
