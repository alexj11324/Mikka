import { assertNoSecret, type SecretFingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'
import { TOOL_PREVIEW_CHARS } from './chat-projection'
import { HIDDEN_TOOLS } from './context'

/**
 * The start of a tool's input or output as text, masked as stored messages are; nothing when it would still
 * carry one of the person's saved secrets.
 */
function preview(userId: string, value: unknown, fingerprints: SecretFingerprint[]): string | undefined {
  if (value === undefined || value === null) return undefined
  const masked = maskDeep(value, credentialMasker)
  const text = (typeof masked === 'string' ? masked : JSON.stringify(masked) ?? '').slice(0, TOOL_PREVIEW_CHARS)
  if (!text) return undefined
  try { assertNoSecret(userId, text, fingerprints) } catch { return undefined }
  return text
}

/**
 * What leaves the durable model stream: assistant text, each tool's name, state and short masked previews,
 * and when the model starts and stops thinking. Reasoning text and whole tool inputs and outputs stay server-side.
 */
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
      } else if (id && (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error')) {
        // A hand-off turn may end quiet, leaving nothing in the chat; its steps never show either.
        if (quietEligible || HIDDEN_TOOLS.has(part.toolName)) return
        const state = part.type === 'tool-call' ? 'running' : part.type === 'tool-result' ? 'done' : 'error'
        const input = part.type === 'tool-call' ? preview(userId, part.input, fingerprints) : undefined
        const output = part.type === 'tool-result' ? preview(userId, part.output, fingerprints) : undefined
        controller.enqueue({ type: 'tool', id, call: part.toolCallId, name: part.toolName, state, ...(input ? { input } : {}), ...(output ? { output } : {}) })
      } else if (id && (part.type === 'reasoning-start' || part.type === 'reasoning-end')) {
        if (quietEligible) return
        controller.enqueue({ type: 'thinking', id, state: part.type === 'reasoning-start' ? 'start' : 'end' })
      } else if (id && part.type === 'error') {
        controller.enqueue({ type: 'error' })
      }
    },
  })
}
