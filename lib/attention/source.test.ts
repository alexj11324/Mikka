import test from 'node:test'
import assert from 'node:assert/strict'
import { fullSource } from './source'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import type { ComposioActionName, ComposioActionResult } from '@/lib/composio-actions'

const notice: ExternalNotification = { userId: 'u', source: 'gmail', externalId: 'msg', matterKey: 'gmail:t', action: 'reply', title: 't', url: null, actor: null, occurredAt: new Date(), required: false, direct: false, fromSelf: false, automated: false, excerpt: '' }
test('source rereads use the originating account and never fall back when missing', async () => {
  const calls: unknown[][] = []
  const execute = async (...args: [string, ComposioActionName, unknown, string?]): Promise<ComposioActionResult> => { calls.push(args); return { data: { messageText: 'body', messages: [{ text: 'hello' }] }, accountId: args[3]! } }
  assert.equal(await fullSource(notice, execute), null)
  assert.deepEqual(calls, [])
  assert.match((await fullSource({ ...notice, connectedAccountId: 'source-a' }, execute))!, /body/)
  assert.equal(calls[0][3], 'source-a')
  assert.match((await fullSource({ ...notice, source: 'slack', matterKey: 'slack:C1:123', connectedAccountId: 'source-b' }, execute))!, /hello/)
  assert.equal(calls[1][3], 'source-b')
})
