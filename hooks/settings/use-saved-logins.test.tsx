import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'
import type { SavedLogin, SavedLoginUse } from '@/lib/settings/saved-logins'

let personal: { secrets: { id: string }[] } | Error
let workspace: { secrets: { id: string }[]; role: string } | Error
function read<T>(value: T | Error): T {
  if (value instanceof Error) throw value
  return value
}
let list: { logins: SavedLogin[] } | { error: string } | Error
let usage: { uses: SavedLoginUse[] } | { error: string } | Error
const unused = async () => ({})
mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => () => 'Read failed' } })
mock.module('@/lib/settings-read', { namedExports: { settingsRead: async (name: string) => name === 'secrets' ? read(workspace) : read(list) } })
mock.module('@/app/actions/user-secrets', { namedExports: { createMySecret: unused, deleteMySecret: unused, importMySecrets: unused, listMySecrets: async () => read(personal), replaceMySecret: unused } })
mock.module('@/app/actions/workspace-secrets', { namedExports: { createSecret: unused, deleteSecret: unused, importSecrets: unused, replaceSecret: unused } })
mock.module('@/app/actions/settings-activity', { namedExports: {
  deleteSavedLogin: unused, replaceSavedLoginPassword: unused, saveSavedLogin: unused,
  listSavedLoginUsage: async () => { if (usage instanceof Error) throw usage; return usage },
} })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let hooks: typeof import('./use-secrets')
let SavedLoginsSettings: typeof import('@/components/settings/saved-logins-settings')['SavedLoginsSettings']
let mine: ReturnType<typeof hooks.useMySecrets>, shared: ReturnType<typeof hooks.useWorkspaceSecrets>
let saved: ReturnType<typeof hooks.useSavedLogins>, used: ReturnType<typeof hooks.useSavedLoginUsage>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  hooks = await import('./use-secrets')
  ;({ SavedLoginsSettings } = await import('@/components/settings/saved-logins-settings'))
})
beforeEach(() => {
  personal = { secrets: [] }; workspace = { secrets: [], role: 'member' }
  list = { logins: [] }; usage = { uses: [] }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
function Probe() {
  mine = hooks.useMySecrets('workspace')
  shared = hooks.useWorkspaceSecrets('workspace')
  saved = hooks.useSavedLogins()
  used = hooks.useSavedLoginUsage('one')
  return null
}
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe /><SavedLoginsSettings /></SWRConfig>))
  await settle()
}

for (const source of ['list', 'usage'] as const) {
  for (const failure of ['action', 'network'] as const) {
    test(`saved-login ${source} ${failure} failure remains a failed read and can retry`, async () => {
      const rejected = failure === 'action' ? { error: 'credentialVaultUnavailable' } : new Error('offline')
      if (source === 'list') list = rejected
      else usage = rejected
      await render()
      assert.equal(source === 'list' ? saved.failed : used.failed, true)
      if (source === 'list') {
        assert.ok(container.textContent?.includes('Settings.logins.loadError'))
        assert.ok(!container.textContent?.includes('Settings.logins.empty'))
      }
      personal = { secrets: [] }; workspace = { secrets: [], role: 'member' }
  list = { logins: [] }; usage = { uses: [] }
      await act(async () => { if (source === 'list') await saved.reload(); else await used.reload() })
      await settle()
      assert.equal(source === 'list' ? saved.failed : used.failed, false)
    })
  }
}

test('a confirmed empty vault still shows its empty state', async () => {
  await render()
  assert.equal(saved.failed, false)
  assert.equal(used.failed, false)
  assert.ok(container.textContent?.includes('Settings.logins.empty'))
})

test('a failed refresh withdraws cached rows and workspace permissions until a successful retry', async () => {
  const login: SavedLogin = { id: 'one', site: 'https://example.invalid', account: 'fixture', lastUsedAt: null, lastUsedBy: null }
  const use: SavedLoginUse = { id: 'one', at: '2026-01-01T00:00:00Z', botName: 'fixture', botId: null, issueId: null, runId: null, subagentId: null, result: 'session_applied' }
  const restore = () => {
    personal = { secrets: [{ id: 'mine' }] }
    workspace = { secrets: [{ id: 'shared' }], role: 'admin' }
    list = { logins: [login] }
    usage = { uses: [use] }
  }
  async function reload() {
    await act(async () => {
      mine.reload()
      shared.reload()
      await Promise.all([saved.reload(), used.reload()])
    })
    await settle()
  }
  restore()
  await render()
  assert.equal(mine.secrets?.[0]?.id, 'mine')
  assert.equal(shared.role, 'admin')
  assert.equal(saved.logins[0]?.id, 'one')
  assert.equal(used.uses[0]?.id, 'one')

  personal = workspace = list = usage = new Error('read unavailable')
  await reload()
  assert.ok(mine.error)
  assert.ok(shared.error)
  assert.equal(mine.secrets, null)
  assert.equal(shared.secrets, null)
  assert.equal(shared.role, null)
  assert.equal(saved.failed, true)
  assert.equal(used.failed, true)
  assert.deepEqual(saved.logins, [])
  assert.deepEqual(used.uses, [])

  restore()
  await reload()
  assert.equal(mine.secrets?.[0]?.id, 'mine')
  assert.equal(shared.secrets?.[0]?.id, 'shared')
  assert.equal(shared.role, 'admin')
  assert.deepEqual(saved.logins, [login])
  assert.deepEqual(used.uses, [use])
})
