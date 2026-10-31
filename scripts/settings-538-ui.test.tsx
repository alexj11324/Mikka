import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// #538 UI: 通用 「重新播放引导」 and the E2B row's capability, with the server actions mocked.
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const translator = (namespace: string) => {
  const lookup = (key: string, args?: Record<string, string>) => {
    const value = `${namespace}.${key}`.split('.').reduce((node, part) => node?.[part], zh)
    assert.equal(typeof value, 'string', `missing ${namespace}.${key}`)
    return (value as string).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
  }
  return Object.assign(lookup, { has: () => false })
}
mock.module('next-intl', { namedExports: { useTranslations: translator } })

let general: unknown
let capability: unknown
mock.module('swr', { defaultExport: (key: unknown[]) => {
  const data = key[0] === 'workspace:general' ? general : key[0] === 'settings:e2b-key' ? capability : key[0] === 'settings:secrets' ? { secrets: [] } : undefined
  return { data, error: undefined, mutate: async () => data }
} })
const reset = mock.fn(async () => {})
const save = mock.fn(async () => ({ configured: true, lastErrorCode: null, lastErrorAt: null }))
const unused = async () => { throw new Error('not called') }
mock.module('@/app/actions/onboarding', { namedExports: { resetOnboarding: reset, completeOnboarding: unused } })
mock.module('@/app/actions/workspace-settings', { namedExports: { deleteWorkspace: unused, getWorkspaceDeletionImpact: unused, getWorkspaceGeneral: unused, getWorkspaceTransferTargets: unused, transferWorkspace: unused, updateWorkspace: unused } })
mock.module('@/app/actions/workspace-secrets', { namedExports: { createSecret: unused, deleteSecret: unused, listSecrets: unused, replaceSecret: unused, getE2BKey: unused, getE2BKeyCapability: async () => capability, saveE2BKey: save, deleteE2BKey: async () => ({ removed: true }) } })
mock.module('@/hooks/use-feature-availability', { namedExports: { useGatedFeature: () => false } })

const browser = new Window({ url: 'https://mikka.example/zh-CN/settings' })
const assigned: string[] = []
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let WorkspaceSettings: typeof import('../components/settings/workspace-settings')['WorkspaceSettings']
let SecretsSettings: typeof import('../components/settings/secrets-settings')['SecretsSettings']

before(async () => {
  Object.defineProperty(browser.location, 'assign', { configurable: true, value: (url: string) => { assigned.push(url) } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ WorkspaceSettings } = await import('../components/settings/workspace-settings'))
  ;({ SecretsSettings } = await import('../components/settings/secrets-settings'))
})
beforeEach(() => {
  general = { id: 'w1', name: 'Acme', slug: 'acme', icon: null, canEdit: false, canTransfer: false }
  capability = { canEdit: true, byoEnabled: true, configured: true, lastErrorCode: null, lastErrorAt: null }
  assigned.length = 0
  reset.mock.resetCalls()
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); (container as unknown as { remove(): void }).remove() })
after(() => browser.happyDOM.close())

const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as unknown as HTMLButtonElement | undefined
const status = () => document.querySelector('[role="status"]')?.textContent

test('通用 offers 重新播放引导 to members too; it resets and reloads the app', async () => {
  await act(async () => root.render(<WorkspaceSettings workspaceId="w1" />))
  assert.ok(container.textContent?.includes('重新播放引导'))
  await act(async () => button('重新播放')!.click())
  assert.equal(reset.mock.callCount(), 1)
  assert.deepEqual(assigned, ['/'])
})

test('a failed reset stays on the page with 重试', async () => {
  reset.mock.mockImplementationOnce(async () => { throw new Error('down') })
  await act(async () => root.render(<WorkspaceSettings workspaceId="w1" />))
  await act(async () => button('重新播放')!.click())
  assert.deepEqual(assigned, [])
  assert.ok(document.querySelector('[role="alert"]'))
  await act(async () => button('重试')!.click())
  assert.equal(reset.mock.callCount(), 2)
  assert.deepEqual(assigned, ['/'])
})

test('the E2B row shows the key state', async () => {
  await act(async () => root.render(<SecretsSettings workspaceId="w1" />))
  assert.equal(status(), '已设置')
  assert.ok(button('更换'))
})

test('someone who may not set the key sees its state without 设置', async () => {
  capability = { canEdit: false, byoEnabled: true, configured: false, lastErrorCode: null, lastErrorAt: null }
  await act(async () => root.render(<SecretsSettings workspaceId="w1" />))
  assert.equal(status(), '未设置')
  assert.equal(button('设置'), undefined)
})
