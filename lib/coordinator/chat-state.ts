import { coordinatorLeaseActive } from './lease'
import { MAX_WAKE_ATTEMPTS } from './wake-recovery'

type Session = { leaseHolder?: string | null; leaseUntil: Date | null; lastError: string | null }
type WaitingEvent = {
  kind: string; tier: string | null; wakeAttempts: number
  wakeLeaseUntil: Date | null; wakeLastError: string | null
}

/** A wake lease acknowledges inbox delivery, not the duration of a model turn. */
export function coordinatorChatState(session: Session | undefined, waiting: readonly WaitingEvent[], now = new Date()): { working: boolean; error: string | null } {
  if (coordinatorLeaseActive(session, now)) return { working: true, error: session?.lastError ?? null }
  const pending = waiting.filter(event => event.tier !== 'background' && event.kind !== 'matter_handoff')
  if (pending.some(event => event.wakeAttempts === 0 || (event.wakeLeaseUntil && event.wakeLeaseUntil > now))) {
    return { working: true, error: session?.lastError ?? null }
  }
  const failed = pending.find(event => event.wakeAttempts < MAX_WAKE_ATTEMPTS) ?? pending[0]
  return { working: false, error: failed
    ? failed.wakeAttempts >= MAX_WAKE_ATTEMPTS ? 'wake_exhausted' : failed.wakeLastError === 'wake_failed' ? 'wake_failed' : 'wake_start_unconfirmed'
    : session?.lastError ?? null }
}
