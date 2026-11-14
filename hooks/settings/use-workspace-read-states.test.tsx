import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'

let targets: unknown, impact: unknown, archived: unknown, profile: unknown
const forbidden = async () => { throw new Error('Unexpected workspace mutation') }
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => (code?: string) => !code || code === 'generic' ? 'Read failed' : code } })
mock.module('@/lib/settings-read', { namedExports: { settingsRead: async (read: string) => {
  const value = read === 'workspace-general' ? profile : read === 'transfer-targets' ? targets : impact
  if (value instanceof Error) throw value
  return value
} } })
mock.module('@/app/actions/workspace-settings', { namedExports: {
  deleteWorkspace: forbidden, transferWorkspace: forbidden, updateWorkspace: forbidden, takeOverArchivedBot: forbidden,
  listArchivedBots: async () => { if (archived instanceof Error) throw archived; return archived },
} })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let hooks: typeof import('./use-workspace-general')
let ArchivedBotsSettings: typeof import('@/components/settings/archived-bots-settings')['ArchivedBotsSettings']
let transfer: ReturnType<typeof hooks.useTransferWorkspace>, deletion: ReturnType<typeof hooks.useDeleteWorkspace>, bots: ReturnType<typeof hooks.useArchivedBots>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  hooks = await import('./use-workspace-general')
  ;({ ArchivedBotsSettings } = await import('@/components/settings/archived-bots-settings'))
})
beforeEach(() => {
  targets = []; impact = { bots: 2, tasks: 3, teams: 1, purchasedPoints: 0 }; archived = { bots: [] }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
function Probe() { transfer = hooks.useTransferWorkspace('workspace'); deletion = hooks.useDeleteWorkspace('workspace'); bots = hooks.useArchivedBots('workspace'); return <ArchivedBotsSettings workspaceId="workspace" /> }
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe /></SWRConfig>))
  await settle()
}
for (const source of ['targets', 'impact', 'archived'] as const) {
  for (const failure of ['network', 'action'] as const) {
    test(`workspace ${source} ${failure} failure exposes a read error and retry`, async () => {
      const rejected = failure === 'network' ? Error('offline') : { error: 'generic' }
      if (source === 'targets') targets = rejected
      else if (source === 'impact') impact = rejected
      else archived = rejected
      await render()
      const state = () => source === 'targets' ? transfer : source === 'impact' ? deletion : bots
      assert.equal(state().readError, 'Read failed')
      if (source === 'archived') assert.ok(container.querySelector('[role="alert"]'))
      targets = [{ userId: 'new-owner', name: 'Owner', email: 'owner@example.invalid' }]
      impact = { bots: 2, tasks: 3, teams: 1, purchasedPoints: 0 }
      archived = { bots: [] }
      await act(async () => { await state().reload() })
      await settle()
      assert.equal(state().readError, null)
      if (source === 'targets') assert.equal(transfer.people?.[0].userId, 'new-owner')
      if (source === 'impact') assert.equal(deletion.counts?.tasks, 3)
    })
  }
}
test('an archived-bot read denied to members retains the intentional absence', async () => {
  archived = { error: 'workspaceAccessDenied' }
  await render()
  assert.equal(bots.readError, null)
  assert.equal(container.textContent, '')
})

test('General withdraws the last workspace profile and preserves the draft until a successful retry', async () => {
  let general!: ReturnType<typeof hooks.useWorkspaceGeneral>
  const currentProfile = () => general.data
  function Profile() {
    general = hooks.useWorkspaceGeneral('workspace')
    return null
  }
  profile = { id: 'workspace', name: 'Original', slug: 'original', canEdit: true, canTransfer: true, personal: false, icon: null }
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><Profile /></SWRConfig>))
  await settle()
  assert.equal(currentProfile()?.name, 'Original')
  await act(async () => general.setName('Unsaved name'))
  profile = new TypeError('Disconnected')
  await act(async () => general.reload())
  await settle()
  assert.equal(currentProfile(), null)
  assert.equal(general.loadError, 'Read failed')
  assert.equal(general.name, 'Unsaved name')
  const { ReadResponseError } = await import('@/lib/swr/retry')
  profile = new ReadResponseError(403)
  await act(async () => general.reload())
  await settle()
  assert.equal(currentProfile(), null)
  assert.equal(general.loadError, 'workspaceAccessDenied')
  profile = { id: 'workspace', name: 'Updated', slug: 'updated', canEdit: false, canTransfer: false, personal: false, icon: null }
  await act(async () => general.reload())
  await settle()
  assert.equal(currentProfile()?.name, 'Updated')
  assert.equal(currentProfile()?.canEdit, false)
  assert.equal(general.loadError, null)
})
