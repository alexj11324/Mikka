import { createHash } from 'node:crypto'
import type { ReplyWaitCompletion } from './reply-wait'

/** One content-free terminal record. Hashing/logging runs inside the waiter's
 * isolated completion callback, never on its read or cancellation path. */
export function logReplyCompletion(botId: string, completion: ReplyWaitCompletion, log: (line: string) => void = line => console.info(line)) {
  log(JSON.stringify({
    msg: 'mcp_reply_wait_complete',
    version: 1,
    botRef: createHash('sha256').update(botId).digest('hex').slice(0, 12),
    outcome: completion.outcome,
    readCalls: completion.readCalls,
    finalReadCalls: completion.finalReadCalls,
    notificationWakes: completion.notificationWakes,
    lossWakes: completion.lossWakes,
    fallbackWakes: completion.fallbackWakes,
    observedLost: completion.observedLost,
    observerKind: completion.observerKind,
    setupState: completion.setupState,
    observerClosed: completion.observerClosed,
    aborted: completion.aborted,
    setupMs: completion.setupMs,
    durationMs: completion.durationMs,
  }))
}
