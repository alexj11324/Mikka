import { assertNoSecret, type SecretFingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'

/** Only assistant text leaves the durable model stream; tools and reasoning stay server-side. */
export function coordinatorTextStream(userId: string, fingerprints: SecretFingerprint[]) {
  const holdback = Math.max(0, ...fingerprints.map(entry => entry.length - 1))
  let id: string | null = null
  let quietEligible = false
  let text = ''
  let sent = 0
  let stepStart = 0
  let stepText = ''

  function publish(controller: TransformStreamDefaultController<CoordinatorStreamEvent>, complete = false) {
    if (!id) return
    assertNoSecret(userId, text.slice(Math.max(0, sent - holdback)), fingerprints)
    const through = complete ? text.length : Math.max(0, text.length - holdback)
    if (through > sent) controller.enqueue({ type: 'text', id, delta: text.slice(sent, through) })
    sent = through
  }

  return new TransformStream<CoordinatorWorkflowStreamPart, CoordinatorStreamEvent>({
    transform(part, controller) {
      // WorkflowAgent also emits these boundaries between tool-backed model calls.
      const type: string = part.type
      if (part.type === 'coordinator-turn-start') {
        id = part.id
        quietEligible = part.quietEligible
        text = ''; sent = 0; stepStart = 0; stepText = ''
        controller.enqueue({ type: 'start', id })
      } else if (part.type === 'coordinator-turn-committed') {
        if (part.id !== id) throw new Error('coordinator_stream_turn_mismatch')
        if (!part.quiet) publish(controller, true)
        controller.enqueue({ type: 'committed', id: part.id, through: part.through, quiet: part.quiet })
        id = null
      } else if (id && type === 'start-step') {
        stepStart = text.length
        stepText = ''
      } else if (id && part.type === 'reset-step') {
        // A retried durable model step replaces its partial attempt, keeping earlier completed steps.
        text = text.slice(0, stepStart)
        stepText = ''
        const through = Math.min(sent, Math.max(0, text.length - holdback))
        if (sent > through) controller.enqueue({ type: 'reset', id, text: text.slice(0, through) })
        sent = through
      } else if (id && part.type === 'text-delta') {
        stepText += part.text
        // Every model call may decline a handoff. Keep its partial sentinel hidden.
        if (quietEligible && QUIET_REPLY.startsWith(stepText.trim())) return
        text = text.slice(0, stepStart) + (stepStart ? '\n\n' : '') + stepText
        publish(controller)
      } else if (id && part.type === 'error') {
        controller.enqueue({ type: 'error' })
      }
    },
  })
}
