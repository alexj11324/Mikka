import { COMPOSIO_ACTIONS, actionArguments, type ComposioActionClient } from '../composio-actions'
import { listComposioPages } from '../composio-pagination'
import { OperationError, type OperationReceipt } from './ledger'
import { createHash } from 'node:crypto'

export interface CalendarProvider {
  name: string
  prepare(ownerId: string): Promise<{ accountId: string; version: string }>
  execute(input: { ownerId: string; accountId: string; version: string; payload: Record<string, unknown>; idempotencyKey: string; signal: AbortSignal; beforeSend: () => Promise<void> }): Promise<OperationReceipt>
  lookup(input: { ownerId: string; accountId: string; idempotencyKey: string }): Promise<OperationReceipt | null>
}
/** No provider idempotency claim: Composio's create tool contract does not establish
 * a client key or lookup-by-key. Unknown results remain uncertain without resend.
 */
export function composioCalendarProvider(client: ComposioActionClient | null): CalendarProvider {
  async function accounts(ownerId: string) {
    if (!client) throw new OperationError('composioNotConfigured')
    return (await listComposioPages(cursor => client.connectedAccounts.list({ userIds: [ownerId], toolkitSlugs: ['googlecalendar'], statuses: ['ACTIVE'], cursor })))
      .filter(account => account.toolkit.slug === 'googlecalendar' && account.status === 'ACTIVE' && !account.isDisabled)
  }
  return {
    name: 'composio-googlecalendar',
    async prepare(ownerId) {
      const active = await accounts(ownerId)
      if (active.length !== 1) throw new OperationError('integrationAccountUnavailable')
      const tool = await client!.tools.getRawComposioToolBySlug(COMPOSIO_ACTIONS.create_calendar_event.slug)
      if (!tool.version || tool.version === 'latest') throw new OperationError('integrationActionVersionUnavailable')
      return { accountId: active[0].id, version: tool.version }
    },
    async execute(input) {
      input.signal.throwIfAborted()
      if (!(await accounts(input.ownerId)).some(account => account.id === input.accountId)) throw new OperationError('integrationAccountUnavailable')
      input.signal.throwIfAborted()
      await input.beforeSend()
      input.signal.throwIfAborted()
      const result = await client!.tools.execute(COMPOSIO_ACTIONS.create_calendar_event.slug, {
        userId: input.ownerId, connectedAccountId: input.accountId, version: input.version,
        arguments: actionArguments('create_calendar_event', input.payload),
      }, {
        signal: input.signal,
        // The SDK fetches its schema asynchronously inside execute(). This hook
        // runs after that preflight and immediately before its non-retrying write.
        beforeExecute: async ({ params }) => {
          input.signal.throwIfAborted()
          await input.beforeSend()
          input.signal.throwIfAborted()
          return params
        },
      })
      if (!result.successful) throw new OperationError('operationUncertain')
      const data = result.data as Record<string, unknown> | undefined
      const nested = data?.response_data as Record<string, unknown> | undefined
      const id = nested?.id ?? data?.id
      if (typeof id !== 'string' || !id) throw new OperationError('operationUncertain')
      return { providerObjectId: id, evidenceDigest: createHash('sha256').update(JSON.stringify([input.accountId, id])).digest('hex') }
    },
    async lookup() { return null },
  }
}
