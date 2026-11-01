import { actionDecidedEvent } from '../coordinator-events'
import type { ApprovedWriteDecision, StoredWriteProposal } from './approved-writes'
import { writeBindingSchema } from './write-binding'

/** Historical result only. This event grants no execution or retry authority.
 * Distinct states keep an early unknown notice from hiding later readback. */
export function approvedWriteDecisionEvent(proposal: StoredWriteProposal, result: ApprovedWriteDecision) {
  const binding = writeBindingSchema.safeParse(proposal.operationBinding)
  const outcome: Record<string, string> = {}
  if (result.outcome) {
    outcome.id = result.outcome.id
    if (result.outcome.url) outcome.url = result.outcome.url
  }
  return {
    ...actionDecidedEvent({ id: proposal.id, userId: proposal.userId, action: proposal.action, input: proposal.input }, { status: result.status, error: result.error, outcome }),
    botId: binding.success ? binding.data.run?.botId ?? null : null,
    dedupeKey: `approved_write_decided:${proposal.id}:${result.status}`,
  }
}
