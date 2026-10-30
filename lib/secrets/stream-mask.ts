// #438 A: masking streamed output across chunks. Adapters send text token by token
// (codex.ts, cursor.ts), so a secret can arrive split over many deltas of one event batch.
// Per streamed part we hold back, in memory only, the text that could still be the start of a
// secret (mask.ts holdback), mask the whole buffer and release only the safe front. A part's end
// chunk, a run end and the end of the batch flush the rest, masked: nothing is held between
// batches (no stored buffer). Known limit: a value split across two event batches is not joined.
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
  'tool-input-available': { prefix: 'tool', idField: 'toolCallId' },
  'tool-input-error': { prefix: 'tool', idField: 'toolCallId' },
}
const RUN_ENDS = new Set(['finish', 'error', 'abort'])

/** Masks one batch in order. A flushed tail is appended to the part's last delta in this batch. */
export function maskStreamedChunks(chunks: readonly Chunk[], mask: Masker): Chunk[] {
  const out: Chunk[] = []
  const pending = new Map<string, string>()
  const lastDelta = new Map<string, Chunk>()
  /** Appends the part's held tail (masked) to its last delta; a part only gets a pending tail after a delta, so one exists. */
  const release = (key: string) => {
    const held = pending.get(key)
    pending.delete(key)
    const previous = lastDelta.get(key)
    if (!held || !previous) return
    const field = key.startsWith('tool:') ? 'inputTextDelta' : 'delta'
    previous[field] = `${previous[field] as string}${maskStreamStep(mask, held, '', true).release}`
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
      // The full tool input arrives (masked) in tool-input-available / -error: the held partial input is dropped.
      if (end.deltaType) release(key); else pending.delete(key)
      out.push(maskDeep(chunk, mask))
      continue
    }
    if (RUN_ENDS.has(type)) for (const key of Array.from(pending.keys())) release(key)
    out.push(maskDeep(chunk, mask))
  }
  for (const key of Array.from(pending.keys())) release(key)
  return out
}
