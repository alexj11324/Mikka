export type ReplyRetryOutcome = 'queued' | 'working' | 'nothingToRetry' | 'unavailable' | 'unconfirmed'
type RetryReply = { queued: true } | { queued: false; reason?: 'working' | 'nothingToRetry' | 'unavailable' } | { error: string }

const LINES: Record<ReplyRetryOutcome, string> = {
  queued: '回复已排队', working: '回复正在处理', nothingToRetry: '没有待重试的回复', unavailable: '回复暂不可重试', unconfirmed: '重试未确认',
}
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
