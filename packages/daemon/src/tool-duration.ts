import type { RunChunk } from './chunks'

/** Per-session monotonic timings, before outbox batching/retries. Missing starts stay unknown. */
export function toolDuration(clock: () => number = () => performance.now()) {
  const starts = new Map<string, number>()
  return (chunk: RunChunk): RunChunk => {
    if (chunk.type === 'tool-input-available') {
      if (!starts.has(chunk.toolCallId)) starts.set(chunk.toolCallId, clock())
    } else if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
      const started = starts.get(chunk.toolCallId)
      starts.delete(chunk.toolCallId)
      // Discard adapter-supplied timing; only the start observed in this session counts.
      const { toolDurationMs: _untrusted, ...result } = chunk
      const elapsed = started === undefined ? undefined : clock() - started
      return elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
        ? { ...result, toolDurationMs: Math.round(elapsed) } : result
    }
    return chunk
  }
}
