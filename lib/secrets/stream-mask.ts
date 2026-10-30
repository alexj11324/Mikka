// #438 A: masking streamed output across chunks. Adapters send text token by token
// (codex.ts, cursor.ts), so a secret can arrive split over many deltas and over many
// event batches. Per streamed part we keep the raw text that could still be the start of a
// secret (mask.ts holdback), mask the whole buffer and release only the safe front. The part's
// end chunk flushes the rest, masked. Pure: the events route stores `pending` sealed between batches.
import { maskDeep, maskStreamStep, type Masker } from './mask'

type Chunk = Record<string, unknown>
const DELTAS: Record<string, { prefix: string; idField: string; textField: string }> = {
  'text-delta': { prefix: 'text', idField: 'id', textField: 'delta' },
  'reasoning-delta': { prefix: 'reasoning', idField: 'id', textField: 'delta' },
  'tool-input-delta': { prefix: 'tool', idField: 'toolCallId', textField: 'inputTextDelta' },
}
const ENDS: Record<string, { prefix: string; idField: string; deltaType?: string }> = {
  'text-end': { prefix: 'text', idField: 'id', deltaType: 'text-delta' },
  'reasoning-end': { prefix: 'reasoning', idField: 'id', deltaType: 'reasoning-delta' },
  // The full input arrives (masked) in tool-input-available / -error; the held partial input is dropped.
  'tool-input-available': { prefix: 'tool', idField: 'toolCallId' },
  'tool-input-error': { prefix: 'tool', idField: 'toolCallId' },
}
const RUN_ENDS = new Set(['finish', 'error', 'abort'])

/**
 * Masks one batch in order. `pending` (part key → held raw text) is read and updated in place.
 * A flushed tail is appended to the part's last delta in this batch; if the end chunk came in a
 * later batch, the end chunk itself carries the tail as a delta of that part (rare: the text has
 * to end on the start of a secret form).
 */
export function maskStreamedChunks(chunks: readonly Chunk[], mask: Masker, pending: Map<string, string>): Chunk[] {
  const out: Chunk[] = []
  const lastDelta = new Map<string, Chunk>()
  const flush = (key: string): string => {
    const held = pending.get(key)
    pending.delete(key)
    return held ? maskStreamStep(mask, held, '', true).release : ''
  }
  for (const chunk of chunks) {
    const type = typeof chunk.type === 'string' ? chunk.type : ''
    const delta = DELTAS[type]
    if (delta && typeof chunk[delta.idField] === 'string' && typeof chunk[delta.textField] === 'string') {
      const key = `${delta.prefix}:${chunk[delta.idField] as string}`
      const step = maskStreamStep(mask, pending.get(key) ?? '', chunk[delta.textField] as string)
      if (step.pending) pending.set(key, step.pending); else pending.delete(key)
      const masked = { ...maskDeep({ ...chunk, [delta.textField]: '' }, mask), [delta.textField]: step.release }
      lastDelta.set(key, masked)
      out.push(masked)
      continue
    }
    const end = ENDS[type]
    if (end && typeof chunk[end.idField] === 'string') {
      const key = `${end.prefix}:${chunk[end.idField] as string}`
      const tail = flush(key)
      const previous = lastDelta.get(key)
      if (tail && end.deltaType && previous) previous[DELTAS[end.deltaType]!.textField] = `${previous[DELTAS[end.deltaType]!.textField] as string}${tail}`
      else if (tail && end.deltaType) { out.push({ type: end.deltaType, id: chunk.id, delta: tail }); continue }
      out.push(maskDeep(chunk, mask))
      continue
    }
    if (RUN_ENDS.has(type)) {
      for (const key of Array.from(pending.keys())) {
        const tail = flush(key)
        const previous = lastDelta.get(key)
        const field = key.startsWith('tool:') ? 'inputTextDelta' : 'delta'
        if (tail && previous) previous[field] = `${previous[field] as string}${tail}`
      }
    }
    out.push(maskDeep(chunk, mask))
  }
  return out
}
