import type { ComposioActionClient } from '../composio-actions'
import type { OperationReceipt } from './ledger'
import type { WriteProvider } from './write-contract'
import { OperationError } from './write-error'
import { snapshotDigest } from './write-target'

/** Fixed request/response contract for Slack's documented proxy endpoints.
 * Metadata is correlation evidence, not a provider idempotency guarantee. */
export const SLACK_DELIVERY_CONTRACT = 'slack-message-metadata-v1'
const eventType = 'mikka_operation'
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}\.\d{1,6}$/.test(value)
function metadata(input: { idempotencyKey: string; payload: Record<string, unknown> }) {
  return { event_type: eventType, event_payload: { operation_key: input.idempotencyKey, payload_digest: snapshotDigest(input.payload) } }
}
function receipt(input: { accountId: string; payload: Record<string, unknown>; idempotencyKey: string }, ts: string): OperationReceipt {
  return { providerObjectId: ts, evidenceDigest: snapshotDigest([input.accountId, 'send_slack_message', input.payload, input.idempotencyKey, ts]) }
}
export type SlackDelivery = {
  send: WriteProvider['execute']
  lookup: WriteProvider['lookup']
}

/** Owner/account are supplied by the existing approved-write binding. The host
 * rechecks that binding and current connection before invoking either method. */
export function composioSlackDelivery(client: ComposioActionClient | null): SlackDelivery | undefined {
  if (!client) return undefined
  return {
    async send(input) {
      input.signal.throwIfAborted()
      await input.beforeSend()
      input.signal.throwIfAborted()
      const result = await client.tools.proxyExecute({
        endpoint: '/chat.postMessage', method: 'POST', userId: input.ownerId, connectedAccountId: input.accountId,
        body: { channel: input.payload.channel, text: input.payload.text, metadata: metadata(input) },
      }, { signal: input.signal })
      const data = record(result.data)
      if (result.status !== 200 || data.ok !== true || data.channel !== input.payload.channel || !timestamp(data.ts)) throw new OperationError('operationUncertain')
      return receipt(input, data.ts)
    },
    async lookup(input) {
      // Old native-tool writes have no correlation metadata. A text match alone
      // cannot establish that they happened; leave them uncertain.
      if (input.version !== SLACK_DELIVERY_CONTRACT) return null
      const expected = metadata(input), seen = new Set<string>()
      let cursor: string | undefined
      do {
        input.signal?.throwIfAborted()
        const result = await client.tools.proxyExecute({
          endpoint: '/conversations.history', method: 'GET', userId: input.ownerId, connectedAccountId: input.accountId,
          parameters: [
            { in: 'query', name: 'channel', value: String(input.payload.channel) },
            { in: 'query', name: 'include_all_metadata', value: 'true' },
            { in: 'query', name: 'limit', value: 100 },
            ...(cursor ? [{ in: 'query' as const, name: 'cursor', value: cursor }] : []),
          ],
        }, { signal: input.signal })
        const data = record(result.data)
        if (result.status !== 200 || data.ok !== true || !Array.isArray(data.messages)) throw new OperationError('operationUncertain')
        for (const raw of data.messages) {
          const message = record(raw), observed = record(message.metadata), payload = record(observed.event_payload)
          if (observed.event_type === eventType && payload.operation_key === expected.event_payload.operation_key && payload.payload_digest === expected.event_payload.payload_digest && timestamp(message.ts)) return receipt(input, message.ts)
        }
        const next = record(data.response_metadata).next_cursor
        cursor = typeof next === 'string' && next.trim() ? next : undefined
        if (cursor && seen.has(cursor) || data.has_more === true && !cursor) throw new OperationError('operationUncertain')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return null
    },
  }
}
