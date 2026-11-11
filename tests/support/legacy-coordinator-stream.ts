import type { CoordinatorStreamEvent } from '@/lib/coordinator/stream'

/** A tool a live reply is using, as the stream reports it. */
export type CoordinatorLiveTool = { call: string; name: string; state: 'running' | 'done' | 'error'; input?: string; output?: string; quote?: string; at?: number; target?: string; displayName?: string; errorCode?: string; errorDetail?: string }

export type CoordinatorLiveReply = {
  id: string
  text: string
  committedThrough?: number
  quiet?: boolean
  /** Tools in the order they were called; each keeps its latest state. */
  tools?: CoordinatorLiveTool[]
  /** How long the model has thought so far (`ms`), since when it is thinking now, and what it has thought (masked, as it streams; only when readable). */
  thinking?: { ms: number; since?: number; text?: string }
}

/** `now` is when the event arrived; thinking time is measured from these. */
export function coordinatorStreamReply(replies: CoordinatorLiveReply[], event: CoordinatorStreamEvent, now = Date.now()): CoordinatorLiveReply[] {
  if (event.type === 'error') throw new Error('Coordinator stream failed')
  if (event.type === 'start') return [...replies.filter(reply => reply.id !== event.id), { id: event.id, text: '' }]
  return replies.map(reply => {
    if (reply.id !== event.id) return reply
    if (event.type === 'text') return { ...reply, text: reply.text + event.delta }
    if (event.type === 'reset') return { ...reply, text: event.text }
    if (event.type === 'tool') {
      const { type: _type, id: _id, ...tool } = event
      const tools = reply.tools ?? []
      const at = tools.findIndex(item => item.call === tool.call)
      // A result keeps the input preview its call carried.
      return { ...reply, tools: at < 0 ? [...tools, tool] : tools.map((item, index) => index === at ? { ...item, ...tool, ...(tool.input ?? item.input ? { input: tool.input ?? item.input } : {}), ...(tool.quote ?? item.quote ? { quote: tool.quote ?? item.quote } : {}) } : item) }
    }
    if (event.type === 'thinking') {
      const thinking = reply.thinking ?? { ms: 0 }
      if (event.state === 'start') return thinking.since === undefined ? { ...reply, thinking: { ...thinking, since: now } } : reply
      // What it thinks arrives as it thinks; the server separates blocks and replaces a retried step's part.
      if (event.state === 'delta') return { ...reply, thinking: { ...thinking, text: (thinking.text ?? '') + event.text } }
      if (event.state === 'reset') { const { text: _text, ...rest } = thinking; return { ...reply, thinking: { ...rest, ...(event.text ? { text: event.text } : {}) } } }
      if (thinking.since === undefined) return reply
      const { since: _since, ...rest } = thinking
      return { ...reply, thinking: { ...rest, ms: thinking.ms + Math.max(0, now - thinking.since) } }
    }
    return { ...reply, committedThrough: event.through, quiet: event.quiet }
  })
}

/** Whether a live reply has anything to show yet: text, a tool or thinking. */
function shows(reply: CoordinatorLiveReply) {
  return Boolean(reply.text || reply.tools?.length || reply.thinking)
}

export function visibleCoordinatorReplies(replies: CoordinatorLiveReply[], cursor: number | undefined, runId: string | undefined, persistedStreamIds?: string[]) {
  return replies.filter(reply => shows(reply) && !reply.quiet && !persistedStreamIds?.includes(reply.id) && (reply.committedThrough === undefined
    ? Boolean(runId && reply.id.startsWith(`${runId}:`))
    : cursor === undefined || cursor < reply.committedThrough))
}

function parseEvent(line: string): CoordinatorStreamEvent {
  const event = JSON.parse(line)
  if (event && typeof event === 'object') {
    if (event.type === 'error') return { type: 'error' }
    if (typeof event.id === 'string') {
      if (event.type === 'start') return { type: 'start', id: event.id }
      if (event.type === 'text' && typeof event.delta === 'string') return { type: 'text', id: event.id, delta: event.delta }
      if (event.type === 'reset' && typeof event.text === 'string') return { type: 'reset', id: event.id, text: event.text }
      if (event.type === 'committed' && Number.isSafeInteger(event.through) && event.through >= 0 && typeof event.quiet === 'boolean') {
        return { type: 'committed', id: event.id, through: event.through, quiet: event.quiet }
      }
      if (event.type === 'tool' && typeof event.call === 'string' && typeof event.name === 'string' && ['running', 'done', 'error'].includes(event.state)) {
        return { type: 'tool', id: event.id, call: event.call, name: event.name, state: event.state,
          ...(typeof event.input === 'string' ? { input: event.input } : {}), ...(typeof event.output === 'string' ? { output: event.output } : {}), ...(typeof event.quote === 'string' ? { quote: event.quote } : {}),
          ...(typeof event.target === 'string' ? { target: event.target } : {}), ...(typeof event.displayName === 'string' ? { displayName: event.displayName } : {}),
          ...(typeof event.errorCode === 'string' ? { errorCode: event.errorCode } : {}), ...(typeof event.errorDetail === 'string' ? { errorDetail: event.errorDetail } : {}),
          ...(Number.isSafeInteger(event.at) && event.at >= 0 ? { at: event.at } : {}) }
      }
      if (event.type === 'thinking' && (event.state === 'start' || event.state === 'end')) return { type: 'thinking', id: event.id, state: event.state }
      if (event.type === 'thinking' && (event.state === 'delta' || event.state === 'reset') && typeof event.text === 'string') return { type: 'thinking', id: event.id, state: event.state, text: event.text }
    }
  }
  throw new Error('Invalid Coordinator stream event')
}

/** Decode incrementally: a network chunk can end inside UTF-8 or a JSON line. */
export async function readCoordinatorStream(body: ReadableStream<Uint8Array>, onEvent: (event: CoordinatorStreamEvent, sequence?: number) => void, signal?: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const emit = (line: string) => {
    const { sequence } = JSON.parse(line) as { sequence?: unknown }
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || (sequence as number) < 1)) throw new Error('Invalid Coordinator stream sequence')
    onEvent(parseEvent(line), sequence as number | undefined)
  }
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (signal?.aborted) break
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) emit(line)
      }
      if (done) {
        if (buffered.trim()) emit(buffered)
        break
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
