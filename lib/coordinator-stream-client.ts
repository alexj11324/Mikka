import type { CoordinatorStreamEvent } from './coordinator/stream'

export type CoordinatorLiveReply = {
  id: string
  text: string
  committedThrough?: number
  quiet?: boolean
}

export function coordinatorStreamReply(replies: CoordinatorLiveReply[], event: CoordinatorStreamEvent): CoordinatorLiveReply[] {
  if (event.type === 'error') throw new Error('Coordinator stream failed')
  if (event.type === 'start') return [...replies.filter(reply => reply.id !== event.id), { id: event.id, text: '' }]
  return replies.map(reply => reply.id !== event.id ? reply : event.type === 'text'
    ? { ...reply, text: reply.text + event.delta }
    : event.type === 'reset'
      ? { ...reply, text: event.text }
      : { ...reply, committedThrough: event.through, quiet: event.quiet })
}

export function visibleCoordinatorReplies(replies: CoordinatorLiveReply[], cursor: number | undefined, runId: string | undefined, persistedStreamIds?: string[]) {
  return replies.filter(reply => reply.text && !reply.quiet && !persistedStreamIds?.includes(reply.id) && (reply.committedThrough === undefined
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
    }
  }
  throw new Error('Invalid Coordinator stream event')
}

/** Decode incrementally: a network chunk can end inside UTF-8 or a JSON line. */
export async function readCoordinatorStream(body: ReadableStream<Uint8Array>, onEvent: (event: CoordinatorStreamEvent) => void, signal?: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
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
        if (line) onEvent(parseEvent(line))
      }
      if (done) {
        if (buffered.trim()) onEvent(parseEvent(buffered))
        break
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
