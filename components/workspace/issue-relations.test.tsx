import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import useSWR, { SWRConfig } from 'swr'
import { issueKeys } from '@/lib/swr/keys'
import type { Root } from 'react-dom/client'
import type { IssueView } from '@/app/actions/issues'
import { readIssueMetadata } from '@/lib/issue-metadata'

const metadata = readIssueMetadata({ type: 'doc' })
const parent = { id: 'parent', revision: 1, status: 'todo', metadata } as IssueView
const child = { id: 'child', revision: 1, status: 'todo', metadata: { ...metadata, parentId: parent.id } } as IssueView
let rows = [parent, child]
let available = true
const read = async () => {
  if (!available) throw new Error('Task relations unavailable')
  return rows
}
const errorToast = mock.fn((message: string) => message)
mock.module('sonner', { namedExports: { toast: { error: errorToast, success() {} } } })
const save = mock.fn(async (_input: { revision: number }): Promise<{ issue?: IssueView; error?: string }> => ({}))
mock.module(new URL('../../app/actions/issue-operations.ts', import.meta.url).href, {
  namedExports: { listIssueConnections: read, updateIssueRelation: save },
})
mock.module(new URL('../../app/actions/issues.ts', import.meta.url).href, { namedExports: { moveIssue: save } })
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey() {} } })
mock.module('next-intl', { namedExports: { useTranslations: () => Object.assign((key: string) => key, { has: () => true }) } })

let state: ReturnType<typeof import('./issue-relations')['useIssueConnections']>
let useIssueConnections: typeof import('./issue-relations')['useIssueConnections']
let root: Root
const win = new Window()
before(async () => {
  for (const [key, value] of Object.entries({ window: win, document: win.document, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  const { createRoot } = await import('react-dom/client')
  root = createRoot(document.body)
  ;({ useIssueConnections } = await import('./issue-relations'))
})
after(async () => { if (root) await act(async () => root.unmount()); await win.happyDOM.abort() })

let savedParent = parent
function Probe() {
  const { data = parent } = useSWR(issueKeys.detail(parent.id), async () => savedParent)
  state = useIssueConnections({ viewerId: 'viewer', task: data, getCurrent: async () => data, onSaved() {}, disabled: false })
  return null
}

test('failed warm task relations withdraw child rows and actions until a successful retry', async () => {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><Probe /></SWRConfig>))
  assert.deepEqual(state.children.map(row => row.id), ['child'])
  available = false
  await act(async () => { await state.mutate() })
  assert.ok(state.error)
  assert.deepEqual(state.children, [])
  assert.equal(state.rows, undefined)
  assert.ok(state.groups.every(group => group.items.length === 0))
  await state.status(child.id, 1, 'done')
  await state.remove('child', child.id)
  assert.equal(save.mock.callCount(), 0)
  rows = [parent]
  available = true
  await act(async () => { await state.mutate() })
  assert.equal(state.error, undefined)
  assert.deepEqual(state.rows, [parent])
})

test('a stale unlink refreshes the parent before the next explicit removal', async () => {
  savedParent = parent
  rows = [parent, child]
  save.mock.resetCalls()
  await act(async () => root.render(<SWRConfig key="unlink" value={{ provider: () => new Map() }}><Probe /></SWRConfig>))
  savedParent = { ...parent, revision: 2 }
  save.mock.mockImplementationOnce(async () => ({ error: 'issueOutdated' }))
  await act(async () => { await state.remove('child', child.id) })
  assert.equal(save.mock.callCount(), 1)
  assert.equal(errorToast.mock.calls.at(-1)?.arguments[0], 'issueStale')
  assert.equal(save.mock.calls[0].arguments[0].revision, 1)
  save.mock.mockImplementationOnce(async () => ({ issue: savedParent }))
  await act(async () => { await state.remove('child', child.id) })
  assert.equal(save.mock.callCount(), 2)
  assert.equal(save.mock.calls[1].arguments[0].revision, 2)
})

test('a stale status save refreshes the child revision without resubmitting', async () => {
  savedParent = parent
  rows = [parent, child]
  save.mock.resetCalls()
  await act(async () => root.render(<SWRConfig key="status" value={{ provider: () => new Map() }}><Probe /></SWRConfig>))
  rows = [parent, { ...child, revision: 2 }]
  save.mock.mockImplementationOnce(async () => ({ error: 'issueStale' }))
  await act(async () => { await state.status(child.id, state.children[0].revision, 'done') })
  assert.equal(save.mock.callCount(), 1)
  assert.equal(errorToast.mock.calls.at(-1)?.arguments[0], 'issueStale')
  assert.equal(state.children[0].revision, 2)
  save.mock.mockImplementationOnce(async () => ({ issue: { ...child, revision: 3, status: 'done' } }))
  await act(async () => { await state.status(child.id, state.children[0].revision, 'done') })
  assert.equal(save.mock.callCount(), 2)
  assert.equal(save.mock.calls[1].arguments[0].revision, 2)
})
