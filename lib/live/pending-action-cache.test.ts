import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { unstable_serialize } from 'swr'
import { loadPendingActionPage, pendingActionsLiveKeys, pendingActionsPageKey, pendingActionExpiresAt } from './pending-action-cache'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('a pending list has an owner and session key; unresolved identity subscribes to nothing', () => {
  assert.equal(pendingActionsPageKey(undefined, 'session'), null)
  assert.deepEqual(pendingActionsLiveKeys('owner', undefined), [])
  assert.deepEqual(pendingActionsLiveKeys('owner', 'session'), [unstable_serialize(['pending-actions', 'owner', 'session'])])
  assert.notDeepEqual(pendingActionsLiveKeys('owner', 'session'), pendingActionsLiveKeys('peer', 'session'))
  assert.notDeepEqual(pendingActionsLiveKeys('owner', 'session'), pendingActionsLiveKeys('owner', 'new-session'))
})

test('browser and credential cards retain five minutes; account/app cards retain seven days', () => {
  const createdAt = '2026-11-04T20:00:00.000Z'
  assert.equal(pendingActionExpiresAt({ action: 'credential_operation', createdAt }), '2026-11-04T20:05:00.000Z')
  assert.equal(pendingActionExpiresAt({ action: 'browser_operation', createdAt }), '2026-11-04T20:05:00.000Z')
  assert.equal(pendingActionExpiresAt({ action: 'app_tool_call', createdAt }), '2026-11-11T20:00:00.000Z')
  assert.equal(pendingActionExpiresAt({ action: 'send_email', createdAt }), '2026-11-11T20:00:00.000Z')
})

test('the compatible array read retains its server observation and pre-request monotonic time', async () => {
  const start = performance.now()
  globalThis.fetch = async () => Response.json([], { headers: { 'x-mikka-viewer': 'owner', 'x-mikka-observed-at': '2026-11-04T20:00:00.000Z' } })
  const result = await loadPendingActionPage('owner')
  assert.deepEqual(result.items, [])
  assert.equal(result.observedAt, '2026-11-04T20:00:00.000Z')
  assert.ok(result.requestedAt! >= start && result.requestedAt! <= performance.now())
})

test('a changed cookie cannot cache another owner under the old session key', async () => {
  globalThis.fetch = async () => Response.json([{ input: 'private peer card' }], { headers: { 'x-mikka-viewer': 'peer' } })
  await assert.rejects(loadPendingActionPage('owner'), /pendingActionsUnavailable/)
  globalThis.fetch = async () => Response.json({ items: [] }, { headers: { 'x-mikka-viewer': 'owner' } })
  await assert.rejects(loadPendingActionPage('owner'), /pendingActionsUnavailable/)
})
