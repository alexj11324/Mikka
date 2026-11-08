import { assertNoSecret, type SecretFingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { credentialMasker, identityMasker, maskDeep, maskStreamStep, withCredentialMasking } from '@/lib/secrets/mask'
import { coordinatorModelPart, type CoordinatorStreamEvent, type CoordinatorWorkflowStreamPart } from './stream'
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

/** Changes to projection boundaries invalidate the HTTP event cursor, including for recorded raw streams. */
export const COORDINATOR_STREAM_PROJECTION_VERSION = 3

/** Local HTTP projection time, including replay: not the provider's generation clock or send-to-first-text time. */
export type CoordinatorStreamTiming = {
  streamId: string
  fingerprintCount: number
  maxHoldback: number
  firstRawTextMs: number | null
  firstEmittedTextMs: number | null
  committedMs: number | null
  firstEmittedAtCommitted: 0 | 1
  firstBlockedByHoldback: 0 | 1
  quietEligible: 0 | 1
  stopped: 0 | 1
  /** 0 committed, 1 EOF, 2 error, 3 superseded by another turn, 4 HTTP cancellation. */
  terminal: 0 | 1 | 2 | 3 | 4
}

/**
 * What leaves the durable model stream: assistant text, each tool's name, state and short masked previews,
 * when the model starts and stops thinking, and its reasoning as it streams, masked like the text. Whole tool
 * inputs and outputs stay server-side.
 */
export function coordinatorTextStream(userId: string, fingerprints: SecretFingerprint[], options: {
  now?: () => number
  onTiming?: (timing: CoordinatorStreamTiming) => void
} = {}) {
  const holdback = Math.max(0, ...fingerprints.map(entry => entry.length - 1))
  const now = options.now ?? Date.now
  let id: string | null = null
  let quietEligible = false
  let scoped = false
  let stopped = false
  const seenTurns = new Set<string>()
  let startedAt = 0
  let timing: CoordinatorStreamTiming | null = null
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

  const elapsed = () => Math.max(0, now() - startedAt)
  function reportTerminal(terminal: CoordinatorStreamTiming['terminal']) {
    if (!timing) return
    const sample = { ...timing, terminal }
    timing = null
    // Observability cannot interrupt the stream, its credential guard, or cancellation.
    try { options.onTiming?.(sample) } catch { /* No stream data or thrown details enter diagnostics. */ }
  }

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
    if (through > sent) {
      if (timing && timing.firstEmittedTextMs === null) {
        timing.firstEmittedTextMs = elapsed()
        timing.firstEmittedAtCommitted = complete ? 1 : 0
      }
      controller.enqueue({ type: 'text', id, delta: text.slice(sent, through) })
    } else if (timing && timing.firstEmittedTextMs === null && text.length > 0 && holdback > 0 && !complete) {
      timing.firstBlockedByHoldback = 1
    }
    sent = through
  }

  /** The persisted chat trims each completed assistant step, including a stopped partial one. */
  function canonicalStepText() {
    const current = stepText.trim()
    if (quietEligible && QUIET_REPLY.startsWith(current)) return text.slice(0, stepStart)
    return text.slice(0, stepStart) + (stepStart && current ? '\n\n' : '') + current
  }

  /** Replace already emitted whitespace without releasing a saved-secret tail before commit. */
  function finishTextStep(controller: TransformStreamDefaultController<CoordinatorStreamEvent>) {
    if (!id) return
    const next = canonicalStepText()
    if (next === text) return
    assertNoSecret(userId, next, fingerprints)
    text = next
    const through = Math.min(sent, Math.max(0, text.length - holdback))
    if (sent > 0) controller.enqueue({ type: 'reset', id, text: text.slice(0, through) })
    sent = through
  }

  return Object.assign(new TransformStream<CoordinatorWorkflowStreamPart, CoordinatorStreamEvent>({
    transform(part, controller) {
      try {
        if (part.type === 'coordinator-turn-start') {
          if (seenTurns.has(part.id)) return
          reportTerminal(3)
          seenTurns.add(part.id)
          id = part.id
          quietEligible = part.quietEligible
          scoped = part.modelStream === 'scoped-v1'
          stopped = false
          startedAt = now()
          timing = { streamId: id, fingerprintCount: fingerprints.length, maxHoldback: holdback,
            firstRawTextMs: null, firstEmittedTextMs: null, committedMs: null,
            firstEmittedAtCommitted: 0, firstBlockedByHoldback: 0, quietEligible: quietEligible ? 1 : 0, stopped: 0, terminal: 0 }
          text = ''; sent = 0; stepStart = 0; stepText = ''; reasoning.clear(); thought = ''; stepThought = 0; invalidCalls.clear()
          controller.enqueue({ type: 'start', id })
          return
        } else if (part.type === 'coordinator-turn-stopped') {
          if (part.id === id) {
            finishTextStep(controller)
            stopped = true
            if (timing) timing.stopped = 1
          }
          return
        } else if (part.type === 'coordinator-turn-committed') {
          if (part.id !== id) {
            if (seenTurns.has(part.id)) return
            throw new Error('coordinator_stream_turn_mismatch')
          }
          if (timing) timing.committedMs = elapsed()
          if (!part.quiet) { finishTextStep(controller); publish(controller, true) }
          controller.enqueue({ type: 'committed', id: part.id, through: part.through, quiet: part.quiet })
          reportTerminal(0)
          id = null
          return
        }
        if (!id || stopped) return
        const model = coordinatorModelPart(part, id, scoped)
        if (!model) return
        // WorkflowAgent also emits these boundaries between tool-backed model calls.
        part = model
        const type: string = part.type
        if (type === 'start-step') {
          invalidCalls.clear()
          stepStart = text.length
          stepText = ''
          stepThought = thought.length
        } else if (type === 'finish-step') {
          finishTextStep(controller)
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
          if (timing && timing.firstRawTextMs === null && part.text.length > 0) timing.firstRawTextMs = elapsed()
          const previousStepLength = stepText.length
          stepText += part.text
          // Check the raw delta boundary before trimming; saved secrets can include whitespace.
          assertNoSecret(userId, stepText.slice(Math.max(0, previousStepLength - holdback)), fingerprints)
          // Every model call may decline a handoff. Keep its partial sentinel hidden.
          if (quietEligible && QUIET_REPLY.startsWith(stepText.trim())) return
          // Keep raw stepText: later deltas can make its trailing whitespace internal.
          // Wire text and tool offsets must use the same projection before finish-step too.
          text = canonicalStepText()
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
          controller.enqueue({ type: 'tool', id, call: part.toolCallId, name: part.toolName, ...result, ...metadata, ...(input ? { input } : {}), ...(output ? { output } : {}), ...(words ? { quote: words } : {}), ...(part.type === 'tool-call' ? { at: canonicalStepText().length } : {}) })
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
      } catch (error) { reportTerminal(2); throw error }
    },
    flush() { reportTerminal(1) },
  }), {
    // Upstream errors and downstream cancellation bypass TransformStream.flush.
    reportTerminal,
  })
}
