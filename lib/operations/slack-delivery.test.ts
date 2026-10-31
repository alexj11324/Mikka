import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComposioActionClient } from '../composio-actions'
import { composioSlackDelivery, SLACK_DELIVERY_CONTRACT } from './slack-delivery'
import { composioSlackConversationReader } from './slack-conversation-read'
import { composioWriteProvider } from './write-provider'
import { snapshotDigest } from './write-target'

const payload = { channel: 'C12345678', text: 'Controlled fixture' }
const input = { ownerId: 'owner', accountId: 'account', version: SLACK_DELIVERY_CONTRACT, payload, idempotencyKey: 'a'.repeat(64) }
const metadata = { event_type: 'mikka_operation', event_payload: { operation_key: input.idempotencyKey, payload_digest: snapshotDigest(payload) } }

test('Slack sends one account-pinned request with correlation metadata after the final authority fence', async () => {
  const calls: unknown[] = []
  let checked = false
  const client = { tools: { proxyExecute: async (request: unknown, options: { signal: AbortSignal }) => {
    assert.equal(checked, true)
    assert.ok(options.signal)
    calls.push(request)
    return { status: 200, data: { ok: true, channel: payload.channel, ts: '123.456' } }
  } } } as unknown as ComposioActionClient
  const delivery = composioSlackDelivery(client)!
  const receipt = await delivery.send({ ...input, approvalContext: null, signal: new AbortController().signal, beforeSend: async () => { checked = true } })
  assert.equal(receipt.providerObjectId, '123.456')
  assert.deepEqual(calls, [{ endpoint: '/chat.postMessage', method: 'POST', userId: 'owner', connectedAccountId: 'account', body: { ...payload, metadata } }])
  checked = false
  await assert.rejects(delivery.send({ ...input, approvalContext: null, signal: new AbortController().signal, beforeSend: async () => { throw Error('revoked') } }), /revoked/)
  assert.equal(calls.length, 1)
})

test('readback requires exact operation and approved payload metadata, follows the provider cursor, and never posts', async () => {
  let reads = 0
  const client = { tools: { proxyExecute: async (request: { method: string; endpoint: string; parameters: { name: string; value: unknown }[] }) => {
    assert.equal(request.method, 'GET'); assert.equal(request.endpoint, '/conversations.history')
    assert.equal(request.parameters.find(p => p.name === 'channel')?.value, payload.channel)
    assert.equal(request.parameters.find(p => p.name === 'include_all_metadata')?.value, 'true')
    reads++
    if (reads === 1) return { status: 200, data: { ok: true, has_more: true, response_metadata: { next_cursor: 'second-page' }, messages: [
      { ts: '123.001', text: payload.text },
      { ts: '123.002', metadata: { ...metadata, event_payload: { ...metadata.event_payload, operation_key: 'other-operation' } } },
      { ts: '123.003', metadata: { ...metadata, event_payload: { ...metadata.event_payload, payload_digest: 'b'.repeat(64) } } },
    ] } }
    assert.equal(request.parameters.find(p => p.name === 'cursor')?.value, 'second-page')
    return { status: 200, data: { ok: true, messages: [{ ts: '123.456', metadata }] } }
  } } } as unknown as ComposioActionClient
  assert.equal((await composioSlackDelivery(client)!.lookup(input))?.providerObjectId, '123.456')
  assert.equal(reads, 2)
})

test('missing metadata, unreadable history and old uncorrelated writes stay unknown', async () => {
  let reads = 0, result = { status: 200, data: { ok: true, messages: [{ ts: '123.456', text: payload.text }] } }
  const client = { tools: { proxyExecute: async () => { reads++; return result } } } as unknown as ComposioActionClient
  const delivery = composioSlackDelivery(client)!
  assert.equal(await delivery.lookup(input), null)
  assert.equal(await delivery.lookup({ ...input, version: 'legacy-native-version' }), null)
  assert.equal(reads, 1)
  result = { status: 403, data: { ok: false, messages: [] } }
  await assert.rejects(delivery.lookup(input), /operationUncertain/)
})

test('the product provider pins its proxy contract and checks the current owner connection before readback', async () => {
  let active = true, historyReads = 0
  const client = {
    connectedAccounts: { list: async ({ userIds }: { userIds: string[] }) => {
      assert.deepEqual(userIds, ['owner'])
      return { items: active ? [{ id: 'account', toolkit: { slug: 'slack' }, status: 'ACTIVE', isDisabled: false }] : [] }
    } },
    tools: { proxyExecute: async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === '/conversations.info') return { status: 200, data: { ok: true, channel: { id: payload.channel, is_member: true } } }
      assert.equal(endpoint, '/conversations.history'); historyReads++
      return { status: 200, data: { ok: true, messages: [{ ts: '123.456', metadata }] } }
    } },
  } as unknown as ComposioActionClient
  const provider = composioWriteProvider(client, 'send_slack_message', undefined, undefined, composioSlackConversationReader(client), composioSlackDelivery(client))
  assert.equal((await provider.prepare('owner', payload)).version, SLACK_DELIVERY_CONTRACT)
  assert.equal((await provider.lookup(input))?.providerObjectId, '123.456')
  active = false
  await assert.rejects(provider.lookup(input), /integrationAccountUnavailable/)
  assert.equal(historyReads, 1)
})
