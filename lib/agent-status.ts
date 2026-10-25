import type { UIMessageChunk } from 'ai'

/**
 * Agent status chunk, sent on the UI message stream before body text arrives:
 *   data: {"type":"data-agent-status","data":{"phase":"searching","tool":"web_search","step":1},"transient":true}
 * `phase` is `thinking` (sent immediately), `searching` (web_search), `reading` (read_webpage)
 * or `working` (any other tool). `notice` is reserved for future degraded states (e.g. `search_degraded`
 * when search is rate-limited); it is not emitted yet and clients must ignore unknown values. The client hides the status as soon as the first text-delta arrives.
 */
export type AgentStatusPhase = 'thinking' | 'searching' | 'reading' | 'working'
export type AgentStatusNotice = 'search_degraded'
export type AgentStatus = { phase: AgentStatusPhase; tool?: string; step: number; notice?: AgentStatusNotice }
export const agentStatusChunkType = 'data-agent-status'

export function agentStatusPhase(toolName: string): AgentStatusPhase {
  if (toolName === 'web_search') return 'searching'
  if (toolName === 'read_webpage') return 'reading'
  return 'working'
}

function statusChunk(status: AgentStatus): UIMessageChunk {
  return { type: agentStatusChunkType, data: status, transient: true } as UIMessageChunk
}

/** Emits status chunks and logs first-chunk / per-step timings. Logs only durations and tool names, never content. */
export function agentStatusStream(options: { startedAt: number; turnId: string; log?: (entry: Record<string, unknown>) => void }) {
  const log = options.log ?? (entry => console.info(JSON.stringify(entry)))
  const ms = (value: number) => Math.round(value - options.startedAt)
  let step = 0
  let stepStartedAt = 0
  let firstChunkAt: number | undefined
  let firstTextAt: number | undefined
  let hasText = false
  const steps: { step: number; durationMs: number; tools: string[] }[] = []
  let tools: string[] = []
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    start(controller) {
      controller.enqueue(statusChunk({ phase: 'thinking', step: 0 }))
    },
    transform(part, controller) {
      const now = performance.now()
      if (firstChunkAt === undefined && part.type !== 'start') firstChunkAt = now
      if (part.type === 'start-step') {
        step++
        stepStartedAt = now
        tools = []
      } else if (part.type === 'finish-step') {
        steps.push({ step, durationMs: Math.round(now - stepStartedAt), tools })
      } else if (part.type === 'tool-input-start') {
        tools.push(part.toolName)
        if (!hasText) controller.enqueue(statusChunk({ phase: agentStatusPhase(part.toolName), tool: part.toolName, step }))
      } else if (part.type === 'text-delta' && part.delta.trim() && !hasText) {
        hasText = true
        firstTextAt = now
      }
      controller.enqueue(part)
    },
    flush() {
      log({
        event: 'agent.stream.timing', turnId: options.turnId,
        firstModelChunkMs: firstChunkAt === undefined ? null : ms(firstChunkAt),
        firstTextMs: firstTextAt === undefined ? null : ms(firstTextAt),
        totalMs: ms(performance.now()), steps,
      })
    },
  })
}

/** Client-side observer: reports status chunks until the first text-delta, then reports `null`. */
export function observeAgentStatus(onStatus: (status: AgentStatus | null) => void) {
  const decoder = new TextDecoder()
  let pending = ''
  let done = false
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (done) return
      pending += decoder.decode(chunk, { stream: true })
      let end: number
      while (!done && (end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!line.startsWith('data: ')) continue
        try {
          const part = JSON.parse(line.slice(6))
          if (part.type === agentStatusChunkType) onStatus(part.data as AgentStatus)
          else if (part.type === 'text-delta' || part.type === 'error' || part.type === 'finish') {
            done = true
            pending = ''
            onStatus(null)
          }
        } catch { /* Observation must never interrupt the original response stream. */ }
      }
    },
    flush() { if (!done) onStatus(null) },
  })
}
