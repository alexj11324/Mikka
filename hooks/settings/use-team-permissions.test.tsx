import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig, useSWRConfig } from 'swr'
import { Window } from 'happy-dom'
import { settingsKeys } from '@/lib/swr/keys'
import { ReadResponseError } from '@/lib/swr/retry'
import type { AppPolicyControl, ComputerPolicyControl, SharePolicyControl } from './use-team-permissions'

let status = 200
let canEdit = true
let actionError: string | undefined
const reads: string[] = []
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => (code?: string) => code ?? 'generic' } })
mock.module('@/lib/settings-read', { namedExports: { settingsRead: async (read: string) => {
  reads.push(read)
  if (status !== 200) throw new ReadResponseError(status)
  if (actionError) return { error: actionError }
  return read === 'share-policy' ? { allowed: false, canEdit } : { apps: [{ app: 'slack', access: 'deny' }], canEdit }
} } })
const unexpectedSave = async () => { throw new Error('A read retry must never write permissions') }
mock.module('@/app/actions/app-policy', { namedExports: { updateAppPolicy: unexpectedSave } })
mock.module('@/app/actions/personal-policy', { namedExports: { updateSharePolicy: unexpectedSave } })

const browser = new Window({ url: 'https://fixture.example/' })
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let hooks: typeof import('./use-team-permissions')
let computer: ComputerPolicyControl, share: SharePolicyControl, apps: AppPolicyControl
let refresh: ReturnType<typeof useSWRConfig>['mutate']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  hooks = await import('./use-team-permissions')
})
beforeEach(() => {
  status = 200
  actionError = undefined
  canEdit = true
  reads.length = 0
  mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    assert.ok(!init?.method || init.method === 'GET')
    reads.push('computer-policy')
    return Response.json({ enabled: true, permission: 'deny', canEdit }, { status })
  })
  root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
})
afterEach(async () => { await act(async () => root.unmount()); mock.restoreAll() })
after(() => browser.happyDOM.close())

function Probe() {
  refresh = useSWRConfig().mutate
  computer = hooks.useComputerPolicy('workspace')
  share = hooks.useSharePolicy('workspace')
  apps = hooks.useAppPolicy('workspace')
  return null
}
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe /></SWRConfig>))
}
async function revalidate() {
  await act(async () => {
    await Promise.all([settingsKeys.sharePolicy('workspace'), settingsKeys.appPolicy('workspace'), settingsKeys.computerPolicy('workspace')].map(key => refresh(key)))
  })
}

test('failed policy revalidation withdraws saved controls and read retry restores current permissions without a write', async () => {
  await render()
  assert.equal(share.canEdit, true)
  assert.equal(apps.apps.length, 1)
  assert.ok(computer.state?.enabled)
  status = 500
  await revalidate()
  assert.equal(share.data, null)
  assert.equal(apps.data, null)
  assert.equal(computer.state, null)
  assert.equal(share.error, 'generic')
  assert.equal(apps.canEdit, false)
  assert.ok(computer.retryRead && share.retryRead && apps.retryRead)
  canEdit = false
  status = 200
  reads.length = 0
  await act(async () => { await Promise.all([share.retryRead?.(), apps.retryRead?.(), computer.retryRead?.()]) })
  assert.deepEqual(reads.sort(), ['app-policy', 'computer-policy', 'share-policy'])
  assert.equal(share.access, 'deny')
  assert.equal(share.canEdit, false)
  assert.deepEqual(apps.apps, [{ app: 'slack', access: 'deny' }])
  assert.deepEqual(computer.state, { enabled: true, permission: 'deny', canEdit: false })
})

test('terminal authorization reads show the server reason without offering a retry or any editable settings', async () => {
  status = 403
  await render()
  assert.deepEqual([computer.readError, share.error, apps.error], Array(3).fill('workspaceAccessDenied'))
  assert.deepEqual([computer.retryRead, share.retryRead, apps.retryRead], Array(3).fill(undefined))
  status = 200
  actionError = 'workspaceMembershipSuspended'
  await revalidate()
  assert.equal(share.error, actionError)
  assert.equal(apps.error, actionError)
  assert.equal(share.retryRead, undefined)
  assert.equal(apps.retryRead, undefined)
  assert.equal(apps.canEdit || share.canEdit, false)
})
