import { coordinatorLeaseActive } from './lease'
import { MAX_WAKE_ATTEMPTS } from './wake-recovery'
import { readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'

type Session = { leaseHolder?: string | null; leaseUntil: Date | null; lastError: string | null; lastErrorAt?: Date | null; lastFailure?: unknown; nativePending?:boolean }
type WaitingEvent = {
  kind: string; tier: string | null; wakeAttempts: number
  wakeLeaseUntil: Date | null; wakeLastError: string | null; createdAt?: Date
}

/** The last stored message: its role, for a reply the turn round that wrote it (`<lease holder>:<round>`), and when it was stored. */
export type LastMessage = { role: string; streamId?: string; createdAt?: Date }

/**
 * `error` is what the line says; `cause`, when the line is a wake code, is the
 * last turn's own stored failure since that message arrived (decision
 * 2026-11-05-0330: the raw code goes under 详情, never in place of the words).
 */
export type CoordinatorChatState = { working: boolean; error: string | null; cause?: string; failureDetails?: RunFailure }

/** Whether the turn holding the lease has stored its reply: what follows (finishing the execution, a phone push, releasing the lease) is not work the person waits for. */
function replied(session: Session | undefined, last: LastMessage | undefined): boolean {
  return Boolean(session?.leaseHolder && last?.role === 'assistant' && last.streamId?.startsWith(`${session.leaseHolder}:`))
}

/** The session's stored failure, when it was recorded while `event` was waiting (an older one belongs to an earlier message). */
function causeOf(session: Session | undefined, event: WaitingEvent): string | undefined {
  if (!session?.lastError) return undefined
  if (event.createdAt && (!session.lastErrorAt || session.lastErrorAt < event.createdAt)) return undefined
  return session.lastError
}

/** A wake lease acknowledges inbox delivery, not the duration of a model turn. */
export function coordinatorChatState(session: Session | undefined, waiting: readonly WaitingEvent[], now = new Date(), last?: LastMessage): CoordinatorChatState {
  if(session?.nativePending)return {working:true,error:null}
  if (coordinatorLeaseActive(session, now) && !replied(session, last)) return { working: true, error: session?.lastError ?? null }
  const pending = waiting.filter(event => event.tier !== 'background' && event.kind !== 'matter_handoff')
  if (pending.some(event => event.wakeAttempts === 0 || (event.wakeAttempts === 1 && event.wakeLeaseUntil && event.wakeLeaseUntil > now))) {
    return { working: true, error: session?.lastError ?? null }
  }
  // A reply stored after a waiting row answered the chat since: that row's failed wakes are not the chat's
  // current state. An untriaged runtime row (tier null, not the person's) is never taken by a turn
  // (store.wakingEvent), so once its wakes ran out it would otherwise read 回复重试已停止 for good.
  const current = pending.filter(event => !(last?.role === 'assistant' && last.createdAt && event.createdAt && last.createdAt > event.createdAt))
  const failed = current.find(event => event.wakeAttempts < MAX_WAKE_ATTEMPTS || (event.wakeLeaseUntil && event.wakeLeaseUntil > now)) ?? current[0]
  const details = session?.lastError ? readRunFailure(session.lastFailure) : null
  if (!failed) return { working: false, error: session?.lastError ?? null, ...(details ? { failureDetails: details } : {}) }
  const exhausted = failed.wakeAttempts >= MAX_WAKE_ATTEMPTS && (!failed.wakeLeaseUntil || failed.wakeLeaseUntil <= now)
  const cause = causeOf(session, failed)
  return { working: false, error: exhausted ? 'wake_exhausted' : failed.wakeLastError === 'wake_failed' ? 'wake_failed' : 'wake_start_unconfirmed', ...(cause ? { cause, ...(details ? { failureDetails: details } : {}) } : {}) }
}
