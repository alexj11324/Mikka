import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8'))
const translator = (namespace: string) => (key: string, args?: Record<string, string | number>) => {
  const value = `${namespace}.${key}`.split('.').reduce((node, part) => node?.[part], zh)
  assert.equal(typeof value, 'string', `missing ${namespace}.${key}`)
  return (value as string).replace(/\{(\w+)\}/g, (_, name) => String(args?.[name] ?? ''))
}
mock.module('next-intl', { namedExports: { useTranslations: translator, useFormatter: () => ({ dateTime: () => 'date' }) } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => () => '读取失败' } })
type ReadState = { data?: unknown; error?: Error; isLoading?: boolean }
let designation: ReadState, share: ReadState, links: ReadState, preferences: ReadState
const refreshed: string[] = []
mock.module('swr', { defaultExport: (key: string | string[]) => {
  const name = typeof key === 'string' ? key : key[0]
  const state = name === 'preferences' ? preferences : name === 'settings:payment-designation' ? designation : name === 'settings:credit-share' ? share : links
  return { ...state, mutate: async () => { refreshed.push(name) } }
} })
const unused = async () => { throw new Error('unexpected policy mutation') }
mock.module('@/app/actions/preferences', { namedExports: { updatePreferences: unused } })
mock.module('@/app/actions/personal-policy', { namedExports: { getCreditShare: unused, getPaymentDesignation: unused, updateCreditShare: unused, updatePaymentDesignation: unused } })
mock.module('@/app/actions/account', { namedExports: { listSharedLinks: unused, requestDataExport: unused } })
mock.module('@/app/actions/artifacts', { namedExports: { stopSharingArtifact: unused } })

const browser = new Window({ url: 'https://mikka.example/zh-CN/settings' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let PaymentDesignationSettings: typeof import('./payment-designation-settings')['PaymentDesignationSettings']
let NotificationSettings: typeof import('../slots/settings-notifications')['NotificationSettings']
let PrivacySettings: typeof import('./privacy-settings')['PrivacySettings']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ PaymentDesignationSettings } = await import('./payment-designation-settings'))
  ;({ NotificationSettings } = await import('../slots/settings-notifications'))
  ;({ PrivacySettings } = await import('./privacy-settings'))
})
beforeEach(() => {
  designation = { data: { canDesignate: false, mine: false } }
  share = { data: { canShare: false, mine: false, sharers: [] } }
  links = { data: { links: [] } }
  preferences = {}
  refreshed.length = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as HTMLButtonElement | undefined

for (const cached of [false, true]) {
  test(`notification ${cached ? 'refresh' : 'initial read'} failure retries the same preference read and hides switches`, async () => {
    preferences = { error: new Error('offline'), data: cached ? { proactive: true } : undefined }
    await act(async () => root.render(<NotificationSettings />))
    assert.ok(container.querySelector('[role="alert"]'))
    assert.equal(container.querySelector('[role="switch"]'), null)
    await act(async () => button(zh.Settings.notifications.retry)!.click())
    assert.deepEqual(refreshed, ['preferences'])
  })
}

for (const source of ['designation', 'share'] as const) {
  test(`payment ${source} loading keeps an explicit loading state`, async () => {
    if (source === 'designation') designation = { isLoading: true }
    else share = { isLoading: true }
    await act(async () => root.render(<PaymentDesignationSettings workspaceId="w1" />))
    assert.ok(container.querySelector('[role="status"]'))
  })
  for (const failure of ['network', 'action'] as const) {
    test(`payment ${source} ${failure} failure is visible and retries both reads`, async () => {
      const state = failure === 'network' ? { error: new Error('offline') } : { data: { error: 'workspaceAccessDenied' } }
      if (source === 'designation') designation = state
      else share = state
      await act(async () => root.render(<PaymentDesignationSettings workspaceId="w1" />))
      assert.ok(container.querySelector('[role="alert"]'))
      await act(async () => button('重试')!.click())
      assert.deepEqual(refreshed.sort(), ['settings:credit-share', 'settings:payment-designation'])
    })
  }
}

test('payment successfully inapplicable to this workspace remains absent', async () => {
  await act(async () => root.render(<PaymentDesignationSettings workspaceId="w1" />))
  assert.equal(container.textContent, '')
})

test('shared links loading never claims that no public links exist', async () => {
  links = { isLoading: true }
  await act(async () => root.render(<PrivacySettings />))
  assert.ok(container.querySelector('[role="status"]'))
  assert.ok(!container.textContent?.includes(zh.Settings.privacy.sharedLinksNone))
  assert.equal(button(zh.Settings.privacy.manage)?.disabled, true)
})
for (const failure of ['network', 'action'] as const) {
  test(`shared links ${failure} failure offers retry without an empty-state privacy claim`, async () => {
    links = failure === 'network' ? { error: new Error('offline') } : { data: { error: 'unauthorized' } }
    await act(async () => root.render(<PrivacySettings />))
    assert.ok(container.querySelector('[role="alert"]'))
    assert.ok(!container.textContent?.includes(zh.Settings.privacy.sharedLinksNone))
    await act(async () => button('重试')!.click())
    assert.deepEqual(refreshed, ['account:shared-links'])
  })
}

test('successfully empty shared links show the empty state and disable management', async () => {
  await act(async () => root.render(<PrivacySettings />))
  assert.ok(container.textContent?.includes(zh.Settings.privacy.sharedLinksNone))
  assert.equal(button(zh.Settings.privacy.manage)?.disabled, true)
})

test('a failed shared-link refresh keeps known links manageable and shows the error', async () => {
  links = { data: { links: [{ artifactId: 'a1', title: 'Public artifact', links: 2 }] }, error: new Error('offline') }
  await act(async () => root.render(<PrivacySettings />))
  assert.ok(container.querySelector('[role="alert"]'))
  assert.equal(button(zh.Settings.privacy.manage)?.disabled, false)
})
