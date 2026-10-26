// Whether the person's Coordinator is working a turn right now: a turn holds
// the lease (`leaseHolder`) until `leaseUntil`. Shared by readCoordinatorMessages
// and the active-agents list so both agree.
export function coordinatorLeaseActive(session: { leaseHolder?: string | null; leaseUntil: Date | null } | null | undefined, now = new Date()): boolean {
  return Boolean(session?.leaseHolder && session.leaseUntil && session.leaseUntil.getTime() > now.getTime())
}
