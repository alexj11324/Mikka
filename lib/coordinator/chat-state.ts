import { coordinatorLeaseActive } from './lease'
import { MAX_WAKE_ATTEMPTS } from './wake-recovery'

type Session = { leaseHolder?: string | null; leaseUntil: Date | null; lastError: string | null }
type WaitingEvent = {
  kind: string; tier: string | null; wakeAttempts: number
  wakeLeaseUntil: Date | null; wakeLastError: string | null
}

/** The last stored message: its role and, for a reply, the turn round that wrote it (`<lease holder>:<round>`). */
export type LastMessage = { role: string; streamId?: string }

/** Whether the turn holding the lease has stored its reply: what follows (finishing the execution, a phone push, releasing the lease) is not work the person waits for. */
function replied(session: Session | undefined, last: LastMessage | undefined): boolean {
  return Boolean(session?.leaseHolder && last?.role === 'assistant' && last.streamId?.startsWith(`${session.leaseHolder}:`))
}

/** A wake lease acknowledges inbox delivery, not the duration of a model turn. */
export function coordinatorChatState(session: Session | undefined, waiting: readonly WaitingEvent[], now = new Date(), last?: LastMessage): { working: boolean; error: string | null } {
  if (coordinatorLeaseActive(session, now) && !replied(session, last)) return { working: true, error: session?.lastError ?? null }
  const pending = waiting.filter(event => event.tier !== 'background' && event.kind !== 'matter_handoff')
  if (pending.some(event => event.wakeAttempts === 0 || (event.wakeAttempts === 1 && event.wakeLeaseUntil && event.wakeLeaseUntil > now))) {
    return { working: true, error: session?.lastError ?? null }
  }
  const failed = pending.find(event => event.wakeAttempts < MAX_WAKE_ATTEMPTS || (event.wakeLeaseUntil && event.wakeLeaseUntil > now)) ?? pending[0]
  if (!failed) return { working: false, error: session?.lastError ?? null }
  const exhausted = failed.wakeAttempts >= MAX_WAKE_ATTEMPTS && (!failed.wakeLeaseUntil || failed.wakeLeaseUntil <= now)
  return { working: false, error: exhausted ? 'wake_exhausted' : failed.wakeLastError === 'wake_failed' ? 'wake_failed' : 'wake_start_unconfirmed' }
}
