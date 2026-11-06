import { QUIET_REPLY } from '@/lib/attention/handoff'
import type { ModelMessage } from 'ai'
import type { CoordinatorWorkflowStreamPart } from './stream'

// 停止 in a chat: the person stops the turn their bot (the Coordinator
// included) is working on. The turn's workflow listens on a hook named for
// its run; resuming it aborts the model call in flight. What the reply had
// already said stays, marked stopped (workflows/coordinator/workflow.ts).

/** The hook a turn's workflow run listens on for 停止. One per run: the run id is the chat lease's holder. */
export function coordinatorStopToken(holder: string) {
  return `coordinator-stop:${holder}`
}

/**
 * The text the model call cut short by 停止 had streamed, read back from the
 * run's own stream up to the `coordinator-turn-stopped` mark of turn `id`.
 * Completed model calls are already in the turn's response messages; only the
 * call in flight is lost when it aborts, so only its text is returned.
 */
export async function stoppedStepText(stream: ReadableStream<CoordinatorWorkflowStreamPart>, id: string): Promise<string> {
  let inTurn = false
  let quietEligible = false
  let text = ''
  const reader = stream.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value
      const type: string = part.type
      if (part.type === 'coordinator-turn-start') {
        inTurn = part.id === id
        quietEligible = part.quietEligible
        text = ''
      } else if (part.type === 'coordinator-turn-stopped') {
        if (part.id === id) break
      } else if (!inTurn) continue
      else if (type === 'start-step' || part.type === 'reset-step') text = ''
      else if (part.type === 'text-delta') text += part.text
    }
  } finally { await reader.cancel().catch(() => undefined) }
  // A handoff turn may decline with the quiet sentinel; a partial one is not a reply.
  return quietEligible && QUIET_REPLY.startsWith(text.trim()) ? '' : text.trim()
}

/**
 * A stopped turn's messages: the completed model calls, then the words the
 * call in flight had streamed, ending on an assistant message the store marks
 * stopped (an empty one when nothing was said; the prompt drops it). `completed`
 * is the last completed call's text: a stop that came as that call finished
 * must not store its words twice.
 */
export function stoppedMessages(responseMessages: readonly ModelMessage[], said: string, completed: string): ModelMessage[] {
  const messages = [...responseMessages]
  if (said && said !== completed.trim()) messages.push({ role: 'assistant', content: said })
  else if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: '' })
  return messages
}

/** The text of the last assistant message: what a turn's last finished model call said. */
export function lastAssistantText(messages: readonly ModelMessage[]): string {
  const last = messages.findLast(message => message.role === 'assistant')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return last.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

type StopSignal = { readonly aborted: boolean; addEventListener(type: 'abort', listener: () => void): void }

/**
 * A turn, or 停止, whichever comes first. A stopped turn is not waited for: a
 * tool call already running finishes on its own and its result is dropped,
 * while the model call in flight sees the same signal and ends. A turn that
 * fails because it was aborted counts as stopped. Runs in the Workflow body,
 * where the order of a stop and a step result replays the same every time.
 */
export async function untilStopped<T>(turn: Promise<T>, signal: StopSignal): Promise<{ stopped: true } | { stopped: false; result: T }> {
  const stopped = new Promise<{ stopped: true }>(resolve => {
    if (signal.aborted) resolve({ stopped: true })
    else signal.addEventListener('abort', () => resolve({ stopped: true }))
  })
  const ended = turn.then(result => ({ stopped: false as const, result }), (error: unknown) => {
    if (signal.aborted) return { stopped: true as const }
    throw error
  })
  return Promise.race([ended, stopped])
}
