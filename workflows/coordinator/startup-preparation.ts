import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import * as steps from './steps'
import { prepareHostedAgentRound } from './round-preparation'

/** A bounded ordinary inbox commits its receipt before preparation/start.
 * Inbox-only returns immediately after its take, retaining the original
 * durable boundary before either operation. Neither a credential nor a live
 * model object is retained between attempts. */
export async function prepareCoordinatorStartup(userId: string, botId: string, holder: string, writable: WritableStream<CoordinatorWorkflowStreamPart>) {
  'use step'
  const candidate = await steps.hostedStartupSettings(userId)
  if (!candidate) return { kind: 'legacy' as const }
  const store = await import('@/lib/coordinator/store')
  const take = await store.takeStartupInbox(userId, holder, botId, candidate)
  if (take.kind !== 'ready') return take
  const { settings, inbox } = take
  // Schedules retain their separate fresh authority checkpoint. Without a
  // kit snapshot, model selection retains its original durable checkpoint.
  if (!inbox.added || inbox.scheduledRead || !settings.agentKitEnabled) return { ...take, preparation: null }
  const preparing = prepareHostedAgentRound(userId, botId, holder, 0, settings.runtime, settings.mailboxEnabled, false, settings.agentKitEnabled, inbox.sourceEventId)
  const starting = steps.writeStreamPart(writable, { type: 'coordinator-turn-start', id: `${holder}:0`, quietEligible: inbox.handoffOnly, modelStream: 'scoped-v1' })
  try {
    const [preparation] = await Promise.all([preparing, starting])
    return { ...take, preparation }
  } catch (error) {
    // A late execution commit cannot outlive terminal cleanup. Preserve the
    // original FatalError/refusal object, including its no-retry semantics.
    await Promise.allSettled([preparing, starting])
    throw error
  }
}

/** Durable context recovery is separate from fallible execution cleanup, so
 * the original inbox is still available if finish/propose later fails. */
export async function recoverCoordinatorStartup(userId: string, botId: string, holder: string) {
  'use step'
  const store = await import('@/lib/coordinator/store')
  return store.recoverStartupInbox(userId, holder, botId)
}
