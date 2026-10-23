/** View helpers for the existing durable run chunk stream; no new session model. */
export function runIsActive(status: string) {
  return ['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(status)
}

export function runListRefreshInterval(runs: readonly { status: string }[] | undefined) {
  return runs?.some(run => runIsActive(run.status)) ? 5000 : 0
}

export function runStatusKey(status: string) {
  switch (status) {
    case 'queued': case 'preparing': case 'running': case 'waiting_input': case 'finishing':
    case 'succeeded': case 'stopped': case 'failed': case 'cancelled': return status
    default: return null
  }
}

export function runDiscussionId(runId: string) { return `discussion-run-${runId}` }
export function isRunDiscussion(id: string) { return id.startsWith('discussion-run-') }
export function runDiscussionRunId(id: string) { return isRunDiscussion(id) ? id.slice('discussion-run-'.length).split(':')[0] : null }

export type RunOutput = { id: string; kind: 'text' | 'reasoning' | 'tool' | 'error'; text: string }
export function runOutput(chunks: readonly Record<string, unknown>[]): RunOutput[] {
  const output: RunOutput[] = []
  const blocks = new Map<string, RunOutput>()
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      const id = `${kind}:${String(chunk.id ?? index)}`
      let block = blocks.get(id)
      if (!block) { block = { id, kind, text: '' }; blocks.set(id, block); output.push(block) }
      if (typeof chunk.delta === 'string') block.text += chunk.delta
    } else if (chunk.type === 'tool-input-available') {
      const id = `tool:${String(chunk.toolCallId ?? index)}`
      const block: RunOutput = { id, kind: 'tool', text: String(chunk.toolName ?? '') }
      blocks.set(id, block); output.push(block)
    } else if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
      const id = `tool:${String(chunk.toolCallId ?? index)}`
      const block = blocks.get(id)
      const value = chunk.type === 'tool-output-error' ? chunk.errorText : chunk.output
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
      if (block) block.text += `\n${text}`
      else output.push({ id, kind: 'tool', text })
    } else if (chunk.type === 'error' && typeof chunk.errorText === 'string') {
      output.push({ id: `error:${index}`, kind: 'error', text: chunk.errorText })
    }
  }
  return output.filter(block => block.text.trim())
}
