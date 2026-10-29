import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApprovedWriteClientError, decideApprovedWrite, loadApprovedWriteAvailability, loadUnresolvedWrites, readApprovedWrite } from './write-client'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('availability uses only a no-store GET and rejects failed or malformed responses', async () => {
  const calls: (RequestInit | undefined)[] = []
  globalThis.fetch = async (url, options) => { assert.ok(String(url).endsWith('/api/approved-writes')); calls.push(options); return Response.json({ enabled: false }) }
  assert.equal(await loadApprovedWriteAvailability(), false)
  assert.deepEqual(calls, [{ method: 'GET', cache: 'no-store' }])
  globalThis.fetch = async () => Response.json({ enabled: true })
  assert.equal(await loadApprovedWriteAvailability(), true)
  globalThis.fetch = async () => Response.json({ enabled: 'true' })
  await assert.rejects(loadApprovedWriteAvailability(), ApprovedWriteClientError)
  globalThis.fetch = async () => Response.json({ enabled: true }, { status: 503 })
  await assert.rejects(loadApprovedWriteAvailability(), ApprovedWriteClientError)
})

test('disabled discovery is empty; another cookie owner response is never accepted under the current viewer', async () => {
  globalThis.fetch = async () => Response.json({ error: 'approvedWritesDisabled' }, { status: 503 })
  assert.deepEqual(await loadUnresolvedWrites('owner'), { items: [], nextCursor: null, asOf: '' })
  globalThis.fetch = async () => Response.json({ viewerId: 'other', items: [], nextCursor: null, asOf: 'now' })
  await assert.rejects(loadUnresolvedWrites('owner'), ApprovedWriteClientError)
})

test('reads and decisions use the new endpoint with exact durable action identity and no caller-selected authority', async () => {
  const calls: Record<string, unknown>[] = []
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/api/approved-writes'))
    assert.equal(options?.method, 'POST'); assert.equal(options?.credentials, 'same-origin'); assert.equal(options?.cache, 'no-store')
    const body = JSON.parse(String(options?.body)); calls.push(body)
    return Response.json(body.op === 'list' ? { viewerId: 'owner', items: [], nextCursor: null, asOf: 'now' } : body.op === 'view' ? { id: 'action-id', action: 'send_slack_message', status: 'running' } : { status: 'declined', error: null })
  }
  await loadUnresolvedWrites('owner', 'cursor')
  await readApprovedWrite('send_slack_message', 'action-id')
  assert.equal(await decideApprovedWrite('send_slack_message', 'action-id', false), 'declined')
  assert.deepEqual(calls, [{ op: 'list', unresolvedOnly: true, limit: 50, cursor: 'cursor' }, { op: 'view', action: 'send_slack_message', id: 'action-id' }, { op: 'decide', action: 'send_slack_message', id: 'action-id', approve: false }])
})

test('a lost decision response is uncertain and is never retried by the client', async () => {
  let sends = 0
  globalThis.fetch = async () => { sends++; throw Error('synthetic lost response') }
  await assert.rejects(decideApprovedWrite('send_slack_message', 'same-action', true), error => error instanceof ApprovedWriteClientError && error.uncertain)
  assert.equal(sends, 1)
  globalThis.fetch = async () => { sends++; return Response.json({ error: 'writeCommitUnconfirmed' }, { status: 409 }) }
  await assert.rejects(decideApprovedWrite('send_slack_message', 'same-action', true), error => error instanceof ApprovedWriteClientError && error.uncertain)
  assert.equal(sends, 2)
  globalThis.fetch = async () => Response.json({ error: 'writeDenied' }, { status: 409 })
  await assert.rejects(decideApprovedWrite('send_slack_message', 'same-action', true), error => error instanceof ApprovedWriteClientError && !error.uncertain)
})
