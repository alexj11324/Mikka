import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'

let password: { hasPassword: boolean } | { error: string } | Error
const actions: string[] = []
let reads = 0
mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => () => 'Read failed' } })
mock.module('@/lib/settings-read', { namedExports: { settingsRead: async (read: string) => {
  if (read === 'sessions') return { sessions: [] }
  reads++
  if (password instanceof Error) throw password
  return password
} } })
mock.module('@/app/actions/account', { namedExports: {
  changePassword: async () => { actions.push('change'); return { hasPassword: true } },
  setPassword: async () => { actions.push('set'); return { hasPassword: true } },
  revokeOtherSessions: async () => ({}), revokeSession: async () => ({}),
} })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let useSecurity: typeof import('./use-security')['useSecurity']
let SecuritySettings: typeof import('@/components/settings/security-settings')['SecuritySettings']
let security: ReturnType<typeof useSecurity>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useSecurity } = await import('./use-security'))
  ;({ SecuritySettings } = await import('@/components/settings/security-settings'))
})
beforeEach(() => {
  password = new Error('offline'); reads = 0; actions.length = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
function Probe() { security = useSecurity(); return null }
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe /><SecuritySettings /></SWRConfig>))
  await settle()
}

for (const failure of ['network', 'action'] as const) {
  test(`a password ${failure} read failure remains unknown and cannot start a password operation`, async () => {
    if (failure === 'action') password = { error: 'accountReadFailed' }
    await render()
    assert.equal(security.hasPassword, null)
    assert.equal(security.passwordError, 'Read failed')
    assert.ok(!container.textContent?.includes('Settings.security.passwordNotSet'))
    assert.ok(![...container.querySelectorAll('button')].some(button => button.textContent === 'Settings.security.setPassword'))
    assert.equal(await security.savePassword({ current: '', next: 'new-password', revokeOthers: false }), 'Read failed')
    assert.deepEqual(actions, [])
    const before = reads
    password = { hasPassword: true }
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Common.retry')
    assert.ok(retry)
    await act(async () => retry.click())
    await settle()
    assert.ok(reads > before)
    assert.equal(security.hasPassword, true)
    assert.equal(security.passwordError, null)
    assert.ok(container.textContent?.includes('Settings.security.changePassword'))
    await act(async () => { assert.equal(await security.savePassword({ current: 'current-password', next: 'new-password', revokeOthers: true }), null) })
    assert.deepEqual(actions, ['change'])
  })
}

test('only a confirmed password-free account can choose set password', async () => {
  password = { hasPassword: false }
  await render()
  assert.equal(security.hasPassword, false)
  assert.ok(container.textContent?.includes('Settings.security.passwordNotSet'))
  await act(async () => { assert.equal(await security.savePassword({ current: '', next: 'new-password', revokeOthers: false }), null) })
  assert.deepEqual(actions, ['set'])
})
