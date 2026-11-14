import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { SWRConfig } from 'swr'
import type { Root } from 'react-dom/client'
import type { IssueView } from '@/app/actions/issues'
import { readIssueMetadata } from '@/lib/issue-metadata'

const metadata = readIssueMetadata({ type: 'doc' })
const parent = { id: 'parent', status: 'todo', metadata } as IssueView
const child = { id: 'child', status: 'todo', metadata: { ...metadata, parentId: parent.id } } as IssueView
let rows = [parent, child]
let available = true
const read = async () => {
  if (!available) throw new Error('Task relations unavailable')
  return rows
}
const save = mock.fn()
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

function Probe() {
  state = useIssueConnections({ viewerId: 'viewer', task: parent, getCurrent: async () => parent, onSaved() {}, disabled: false })
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
