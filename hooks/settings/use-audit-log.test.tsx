import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'
import { ReadResponseError } from '@/lib/swr/retry'
import type { AuditLogState } from './use-audit-log'

let status = 200
let failOnlyNextPage = false
const requests: string[] = []
mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string) => key } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => () => 'Read failed' } })
mock.module('@/lib/settings-read', { namedExports: { settingsRead: async (_read: string, { cursor }: { cursor?: string }) => {
  requests.push(cursor ?? 'first')
  if (status !== 200 && (!failOnlyNextPage || cursor)) throw new ReadResponseError(status)
  return { events: [{ id: cursor ? 'second' : 'first', createdAt: new Date().toISOString() }], nextCursor: cursor ? null : 'next' }
} } })

const browser = new Window({ url: 'https://fixture.example/' })
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let useAuditLog: typeof import('./use-audit-log')['useAuditLog']
let state: AuditLogState
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useAuditLog } = await import('./use-audit-log'))
})
beforeEach(() => {
  requests.length = 0
  status = 200
  failOnlyNextPage = false
  root = createRoot(document.createElement('div'))
})
afterEach(async () => { await act(async () => root.unmount()) })
after(() => browser.happyDOM.close())

function Probe() {
  state = useAuditLog('workspace')
  return null
}
async function render() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe /></SWRConfig>))
}

test('retry restores a failed audit page without exposing cached events or advancing another cursor', async () => {
  await render()
  assert.deepEqual(state.events.map(event => event.id), ['first'])
  status = 500
  failOnlyNextPage = true
  await act(async () => { state.loadMore() })
  assert.equal(state.errorCode, 'audit_read_failed (http_500)')
  assert.deepEqual(state.events, [])
  assert.equal(state.more, false)
  status = 200
  assert.ok(state.retry)
  await act(async () => { await state.retry?.() })
  assert.deepEqual(state.events.map(event => event.id), ['first', 'second'])
  assert.equal(state.error, null)
  assert.equal(state.more, false)
  assert.equal(requests.filter(cursor => cursor === 'next').length, 2)
})

test('an initial audit read can be retried and a permission refusal does not offer retry', async () => {
  status = 500
  await render()
  assert.ok(state.retry)
  status = 403
  await act(async () => { await state.retry?.() })
  assert.equal(state.errorCode, 'workspaceAccessDenied')
  assert.deepEqual(state.events, [])
  assert.equal(state.retry, undefined)
})
