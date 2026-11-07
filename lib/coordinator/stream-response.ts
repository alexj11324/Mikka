import { assertNoSecret, type SecretFingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { credentialMasker, identityMasker, maskDeep, maskStreamStep, withCredentialMasking } from '@/lib/secrets/mask'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'
import { TOOL_PREVIEW_CHARS } from './chat-projection'
import { HIDDEN_TOOLS, jsonbText, quotePreview, toolQuoteText } from './context'
import { rawToolOperation, rawToolTarget, toolDisplayName, toolLabel, toolResultMetadata, TOOL_TARGET_CHARS, type ToolCallMetadata, type ToolResultMetadata } from './tool-metadata'
import { isInvalidToolResult } from './invalid-tool-call'

/**
 * The start of a tool's input or output as text, masked as stored messages are; nothing when it would still
 * carry one of the person's saved secrets.
 */
function preview(userId: string, value: unknown, fingerprints: SecretFingerprint[]): string | undefined {
  if (value === undefined || value === null) return undefined
  const masked = maskDeep(value, credentialMasker)
  // As the stored chat prints it (jsonb), so a preview cut at the limit reads the same live and stored.
  const text = (typeof masked === 'string' ? masked : jsonbText(masked)).slice(0, TOOL_PREVIEW_CHARS)
  if (!text) return undefined
  try { assertNoSecret(userId, text, fingerprints) } catch { return undefined }
  return text
}

/** A call's words (a dispatch's note) as the chat's quote, masked like the previews; nothing when it holds a saved secret. */
function quote(userId: string, input: unknown, fingerprints: SecretFingerprint[]): string | undefined {
  // Checked whole, before the cut: a saved secret straddling it must not leave even its start.
  const text = toolQuoteText(maskDeep(input, credentialMasker))
  if (!text) return undefined
  try { assertNoSecret(userId, text, fingerprints) } catch { return undefined }
  return quotePreview(text)
}

/** Metadata checks whole source fields before shortening them; a secret can straddle the cutoff. */
function callMetadata(userId: string, name: string, input: unknown, fingerprints: SecretFingerprint[]): ToolCallMetadata {
  const masked = maskDeep(input, credentialMasker)
  let target = rawToolTarget(name, masked), operation = rawToolOperation(name, masked)
  try { if (target) assertNoSecret(userId, target, fingerprints) } catch { target = undefined }
  try { if (operation) assertNoSecret(userId, operation, fingerprints) } catch { operation = undefined }
  const label = toolLabel(target, TOOL_TARGET_CHARS)
  return { displayName: toolDisplayName(name, operation), ...(label ? { target: label } : {}) }
}

/** Keep existing identifier-shaped codes/details, never a thrown message or a credential. */
function resultMetadata(userId: string, value: unknown, forcedError: boolean, fingerprints: SecretFingerprint[]): ToolResultMetadata {
  const receipt = toolResultMetadata(value, forcedError)
  const result: ToolResultMetadata = { state: receipt.state }
  for (const key of ['errorCode', 'errorDetail'] as const) {
    const identifier = receipt[key]
    if (!identifier || credentialMasker(identifier) !== identifier) continue
    try { assertNoSecret(userId, identifier, fingerprints); result[key] = identifier } catch { /* Saved secrets never become metadata. */ }
  }
  return result
}

/** A stored thinking block as the chat may show it: masked like stored messages; nothing if it holds a saved secret. */
export function reasoningText(userId: string, text: string, fingerprints: SecretFingerprint[]): string | undefined {
  const masked = credentialMasker(text.trim())
  if (!masked) return undefined
  try { assertNoSecret(userId, masked, fingerprints) } catch { return undefined }
  return masked
}

/** Credential patterns as a stream masks them: a token still growing at the end is held back until it ends. */
const reasoningMasker = withCredentialMasking(identityMasker)

/** One thinking block as it streams: masked text released so far (`buf`), what was sent of it, the raw tail held back. */
type ReasoningBlock = { pending: string; buf: string; sent: number; blocked: boolean }

/**
 * What leaves the durable model stream: assistant text, each tool's name, state and short masked previews,
 * when the model starts and stops thinking, and its reasoning as it streams, masked like the text. Whole tool
 * inputs and outputs stay server-side.
 */
export function coordinatorTextStream(userId: string, fingerprints: SecretFingerprint[]) {
  const holdback = Math.max(0, ...fingerprints.map(entry => entry.length - 1))
  let id: string | null = null
  let quietEligible = false
  let text = ''
  let sent = 0
  let stepStart = 0
  let stepText = ''
  /** Thinking blocks streaming now, by reasoning block id. */
  const reasoning = new Map<string, ReasoningBlock>()
  /** The turn's reasoning sent so far, and where this model step's part of it starts (a retried step drops it). */
  let thought = ''
  let stepThought = 0
  /** Scoped to this turn; no arbitrary tool name is a hide rule. */
  const invalidCalls = new Set<string>()

  /**
   * Sends what is safe of a thinking block: credential patterns are masked by `maskStreamStep`; the last `holdback`
   * characters wait for the next delta so a saved secret is always checked whole before any of it leaves, as the
   * text does. A saved secret stops the block: nothing more of it is sent.
   */
  function think(controller: TransformStreamDefaultController<CoordinatorStreamEvent>, block: ReasoningBlock, delta: string, final = false) {
    if (!id || block.blocked) return
    const step = maskStreamStep(reasoningMasker, block.pending, delta, final)
    block.pending = step.pending
    block.buf += step.release
    // The first words of a block start at its first non-space character.
    if (!block.sent) block.buf = block.buf.trimStart()
    try { assertNoSecret(userId, block.buf.slice(Math.max(0, block.sent - holdback)), fingerprints) } catch { block.blocked = true; return }
    const through = final ? block.buf.trimEnd().length : Math.max(0, block.buf.length - holdback)
    if (through <= block.sent) return
    const piece = (!block.sent && thought ? '\n\n' : '') + block.buf.slice(block.sent, through)
    block.sent = through
    thought += piece
    controller.enqueue({ type: 'thinking', id, state: 'delta', text: piece })
  }

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
        text = ''; sent = 0; stepStart = 0; stepText = ''; reasoning.clear(); thought = ''; stepThought = 0; invalidCalls.clear()
        controller.enqueue({ type: 'start', id })
      } else if (part.type === 'coordinator-turn-committed') {
        if (part.id !== id) throw new Error('coordinator_stream_turn_mismatch')
        if (!part.quiet) publish(controller, true)
        controller.enqueue({ type: 'committed', id: part.id, through: part.through, quiet: part.quiet })
        id = null
      } else if (id && type === 'start-step') {
        invalidCalls.clear()
        stepStart = text.length
        stepText = ''
        stepThought = thought.length
      } else if (id && part.type === 'reset-step') {
        invalidCalls.clear()
        // A retried durable model step replaces its partial attempt, keeping earlier completed steps.
        reasoning.clear()
        if (thought.length > stepThought) {
          thought = thought.slice(0, stepThought)
          if (!quietEligible) controller.enqueue({ type: 'thinking', id, state: 'reset', text: thought })
        }
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
        if (part.type === 'tool-call' && part.invalid === true) invalidCalls.add(part.toolCallId)
        if (invalidCalls.has(part.toolCallId) || isInvalidToolResult(part)) return
        // A hand-off turn may end quiet, leaving nothing in the chat; its steps never show either.
        if (quietEligible || HIDDEN_TOOLS.has(part.toolName)) return
        const result = part.type === 'tool-call' ? { state: 'running' as const } : resultMetadata(userId, part.type === 'tool-result' ? part.output : part.error, part.type === 'tool-error', fingerprints)
        const metadata = part.type === 'tool-call' ? callMetadata(userId, part.toolName, part.input, fingerprints) : {}
        const input = part.type === 'tool-call' ? preview(userId, part.input, fingerprints) : undefined
        const output = part.type === 'tool-result' ? preview(userId, part.output, fingerprints) : undefined
        const words = part.type === 'tool-call' ? quote(userId, part.input, fingerprints) : undefined
        controller.enqueue({ type: 'tool', id, call: part.toolCallId, name: part.toolName, ...result, ...metadata, ...(input ? { input } : {}), ...(output ? { output } : {}), ...(words ? { quote: words } : {}), ...(part.type === 'tool-call' ? { at: text.length } : {}) })
      } else if (id && part.type === 'reasoning-start') {
        reasoning.set(part.id, { pending: '', buf: '', sent: 0, blocked: false })
        if (!quietEligible) controller.enqueue({ type: 'thinking', id, state: 'start' })
      } else if (id && part.type === 'reasoning-delta') {
        const block = reasoning.get(part.id)
        if (block && !quietEligible) think(controller, block, part.text)
      } else if (id && part.type === 'reasoning-end') {
        const block = reasoning.get(part.id)
        if (block && !quietEligible) think(controller, block, '', true)
        reasoning.delete(part.id)
        if (!quietEligible) controller.enqueue({ type: 'thinking', id, state: 'end' })
      } else if (id && part.type === 'error') {
        controller.enqueue({ type: 'error' })
      }
    },
  })
}
