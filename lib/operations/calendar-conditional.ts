import type { ComposioActionClient } from '../composio-actions'
import type { ConditionalCalendarDelete } from './write-provider'
import { OperationError } from './write-error'

/** A single account-pinned proxy call with the provider's atomic ETag check.
 * The caller holds its authorization lease and supplies the final send fence. */
export function composioConditionalCalendarDelete(client: ComposioActionClient | null): ConditionalCalendarDelete | undefined {
  if (!client) return undefined
  return async input => {
    input.signal.throwIfAborted()
    if (!input.ifMatch || input.ifMatch === '*') throw new OperationError('integrationConditionalWriteUnavailable')
    await input.beforeSend()
    input.signal.throwIfAborted()
    const result = await client.tools.proxyExecute({
      endpoint: `/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
      method: 'DELETE', userId: input.ownerId, connectedAccountId: input.accountId,
      parameters: [{ in:'header',name:'If-Match',value:input.ifMatch }, { in:'query',name:'sendUpdates',value:input.sendUpdates }],
    }, { signal:input.signal })
    return { status:result.status }
  }
}
