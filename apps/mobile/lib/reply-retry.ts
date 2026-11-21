import { mobileMessages } from './messages'

export type ReplyRetryOutcome = 'queued' | 'working' | 'nothingToRetry' | 'unavailable' | 'unconfirmed'
type RetryReply = { queued: true } | { queued: false; reason?: 'working' | 'nothingToRetry' | 'unavailable' } | { error: string }

/** The web's own words for the same outcomes (Coordinator.replyRetry), not a second set. */
const LINES: Record<ReplyRetryOutcome, string> = mobileMessages.Coordinator.replyRetry
export const replyRetryLine = (outcome: ReplyRetryOutcome) => LINES[outcome]

/** A lost transport response can follow a successful enqueue. Only the
 * server's acknowledgement proves what happened; refresh cannot undo it. */
export async function retryReply(request: () => Promise<RetryReply>, refresh: () => unknown): Promise<ReplyRetryOutcome> {
  let result: RetryReply
  try { result = await request() } catch { return 'unconfirmed' }
  if ('error' in result) return 'unavailable'
  const outcome = result.queued ? 'queued' : result.reason === 'working' || result.reason === 'nothingToRetry' || result.reason === 'unavailable' ? result.reason : 'unconfirmed'
  try { await refresh() } catch { /* preserve the acknowledged outcome */ }
  return outcome
}
