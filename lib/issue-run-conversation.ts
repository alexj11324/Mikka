/** View helpers for the existing durable run chunk stream; no new session model. */
export function runIsActive(status: string) {
  return ['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(status)
}

export function runListRefreshInterval(runs: readonly { status: string }[] | undefined) {
  return runs?.some(run => runIsActive(run.status)) ? 5000 : 0
}

export const RUN_STOP_TIMEOUT_MS = 30_000

/** A persisted request retains its deadline across polling and reloads. */
export function runStopTimeoutRemaining(requestedAt: number, now = Date.now()) {
  return Math.max(0, Math.min(RUN_STOP_TIMEOUT_MS, requestedAt + RUN_STOP_TIMEOUT_MS - now))
}

export function runStatusKey(status: string) {
  switch (status) {
    case 'queued': case 'preparing': case 'running': case 'waiting_input': case 'finishing':
    case 'succeeded': case 'stopped': case 'failed': case 'cancelled': return status
    default: return null
  }
}

/** One line about what a finished run did: the report's summary, else the first line of its error. */
export function runSummaryText(run: { report: unknown; error: string | null }): string | null {
  const report = run.report
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    const summary = (report as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary.trim()) return summary.trim()
  }
  return run.error?.split('\n').find(line => line.trim())?.trim() ?? null
}

export type ThreadItem =
  | { kind: 'agent'; id: string; text: string; at: number }
  | { kind: 'steps'; id: string; count: number; at: number }
  | { kind: 'error'; id: string; text: string; at: number }
  | { kind: 'computer'; id: string; botId: string; runId: string; task: string; at: number }
  | { kind: 'person'; id: string; text: string; author: string; image?: string | null; mine: boolean; at: number }

/**
 * A thread as one conversation: the agent's replies from the durable chunk stream,
 * consecutive tool calls folded into one "N steps" line, and what people said, in time order.
 */
export function threadItems(
  chunks: readonly { chunk: Record<string, unknown>; at: Date | string }[],
  messages: readonly { id: string; text: string; author: string; image?: string | null; mine: boolean; at: Date | string }[],
  expectedRunId?: string,
): ThreadItem[] {
  const items: ThreadItem[] = []
  const texts = new Map<string, Extract<ThreadItem, { kind: 'agent' }>>()
  for (const [index, { chunk, at }] of chunks.entries()) {
    const time = new Date(at).getTime()
    const last = items[items.length - 1]
    if (chunk.type === 'text-delta') {
      const id = `text:${String(chunk.id ?? index)}`
      let item = texts.get(id)
      if (!item) { item = { kind: 'agent', id, text: '', at: time }; texts.set(id, item); items.push(item) }
      if (typeof chunk.delta === 'string') item.text += chunk.delta
    } else if (chunk.type === 'tool-input-available') {
      if (last?.kind === 'steps') last.count += 1
      else items.push({ kind: 'steps', id: `steps:${index}`, count: 1, at: time })
    } else if (chunk.type === 'data-computer' && expectedRunId && chunk.data && typeof chunk.data === 'object') {
      const data = chunk.data as Record<string, unknown>
      if (data.runId === expectedRunId && typeof data.botId === 'string' && typeof data.task === 'string' && data.task.length <= 200 && !items.some(item => item.kind === 'computer' && item.runId === expectedRunId))
        items.push({ kind: 'computer', id: `computer:${expectedRunId}`, botId: data.botId, runId: expectedRunId, task: data.task, at: time })
    } else if (chunk.type === 'error' && typeof chunk.errorText === 'string') {
      items.push({ kind: 'error', id: `error:${index}`, text: chunk.errorText, at: time })
    }
  }
  for (const message of messages) items.push({ kind: 'person', id: message.id, text: message.text, author: message.author, image: message.image, mine: message.mine, at: new Date(message.at).getTime() })
  return items.filter(item => item.kind !== 'agent' || item.text.trim()).sort((a, b) => a.at - b.at)
}
