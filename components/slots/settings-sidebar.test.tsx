import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { SettingsSidebarProps } from './settings-sidebar-contract'

const messages = JSON.parse(readFileSync(new URL('../../messages/en.json', import.meta.url), 'utf8'))
const lookup = (path: string) => path.split('.').reduce((part, key) => part?.[key], messages)
const translate = Object.assign((path: string) => {
  const value = lookup(path)
  assert.equal(typeof value, 'string', `missing ${path}`)
  return value as string
}, { has: (path: string) => typeof lookup(path) === 'string' })
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module('next/navigation', { namedExports: { useSearchParams: () => new URLSearchParams() } })
mock.module(new URL('../settings/settings-link.tsx', import.meta.url).href, { namedExports: {
  SettingsLink: (props: Record<string, unknown>) => <a {...props} />,
} })
mock.module(new URL('../../app/actions/teams.ts', import.meta.url).href, { namedExports: { listTeams: async () => [] } })
// The team read has already settled before the Workspace identity arrives.
// This is the cold route ordering that differs from a warm cached Workspace.
const teams: never[] = []
mock.module('swr', { defaultExport: () => ({ data: teams, mutate: async () => teams }) })
mock.module(new URL('../nav/icon-rail.tsx', import.meta.url).href, { namedExports: { RAIL_ITEMS: [] } })

const browser = new Window({ url: 'https://fixture.example/mikka/settings/members' })
let createRoot: typeof import('react-dom/client')['createRoot']
let SidebarProvider: typeof import('../ui/sidebar')['SidebarProvider']
let SettingsSidebar: typeof import('./settings-sidebar')['SettingsSidebar']
let container: HTMLDivElement, root: Root
const revealed: Element[] = []
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.defineProperty(browser.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value(this: Element) { revealed.push(this) } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SidebarProvider } = await import('../ui/sidebar'))
  ;({ SettingsSidebar } = await import('./settings-sidebar'))
})
beforeEach(() => {
  revealed.length = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())
const render = async (props: Pick<SettingsSidebarProps, 'section' | 'admin' | 'personal'> & Partial<Pick<SettingsSidebarProps, 'billing' | 'cloudAdmin'>>) => {
  await act(async () => root.render(<SidebarProvider><SettingsSidebar billing={false} {...props} activeSection={props.section}
    workspaceName="Workspace fixture" onSectionChange={() => {}} onRail={() => {}} /></SidebarProvider>))
}
const selectedGroup = () => container.querySelector('[aria-current="page"]')?.closest('[data-slot="sidebar-group"]')

test('a warm Workspace reveals the selected settings group', async () => {
  await render({ section: 'members', personal: false, admin: true })
  const group = selectedGroup()
  assert.ok(group)
  assert.ok(revealed.includes(group))
})

test('a cold Workspace reveals its selected group after team visibility becomes known', async () => {
  await render({ section: 'members', personal: true, admin: false })
  assert.equal(selectedGroup(), undefined)
  await render({ section: 'members', personal: false, admin: true })
  const group = selectedGroup()
  assert.ok(group, 'the resolved Workspace makes the selected route available')
  assert.ok(revealed.includes(group), 'revealing a previously unavailable route must also bring its group into view')
})

test('a selected admin section is revealed when the authoritative role arrives', async () => {
  await render({ section: 'audit', personal: false, admin: false })
  assert.equal(selectedGroup(), undefined)
  await render({ section: 'audit', personal: false, admin: true })
  const group = selectedGroup()
  assert.ok(group)
  assert.ok(revealed.includes(group), 'a role-dependent group must be revealed after its selected item appears')
})

for (const capability of ['billing', 'cloudAdmin'] as const) {
  test(`the selected group is revealed again when ${capability} changes its contents`, async () => {
    await render({ section: 'environments', personal: false, admin: true, [capability]: false })
    assert.ok(selectedGroup())
    revealed.length = 0
    await render({ section: 'environments', personal: false, admin: true, [capability]: true })
    const group = selectedGroup()
    assert.ok(group)
    assert.ok(revealed.includes(group), 'newly available controls must not leave the selected group clipped')
  })
}
