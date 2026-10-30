/** Client view of a Factory acceptance (R-56). Pure so every state is testable without a server. */
export type AcceptanceState = 'pending' | 'approved' | 'publishing' | 'checking' | 'failed' | 'live' | 'revoked' | 'expired' | 'invalidated' | 'unavailable'
export type AcceptanceApproval = { id: string; candidateId: string; expiresAt: string; revokedAt: string | null }
export type AcceptancePublication = { approvalId: string; status: 'reserved' | 'uncertain' | 'succeeded' | 'failed' }

/** The copy key for a state. A skill is enabled, not published: 待启用 / 已启用 (Figma 588:56073). */
export function acceptanceStateKey(state: AcceptanceState, isSkill: boolean): `state.${AcceptanceState}` | `skillState.${'pending' | 'live'}` {
  if (isSkill && (state === 'pending' || state === 'live')) return `skillState.${state}`
  return `state.${state}`
}

export function acceptanceState(input: {
  stage: string
  candidateId: string | null
  approvals: AcceptanceApproval[]
  publications: AcceptancePublication[]
  now: number
}): { state: AcceptanceState; active?: AcceptanceApproval; publication?: AcceptancePublication } {
  // Precedence (R-56):
  // 1. Only approvals on the current candidate count; the latest of them decides
  //    (a newer revoke beats an older valid approval, a newer approval beats an older revoke).
  // 2. An approval is active only while now < expiresAt (expiresAt == now is expired).
  // 3. Approvals on an older candidate never count: with no current approval the task is
  //    back to pending review at the approval stage, otherwise it reads invalidated.
  const { now } = input
  const isCurrent = (approval: AcceptanceApproval) => !input.candidateId || approval.candidateId === input.candidateId
  const approvals = input.approvals.filter(isCurrent)
  const stale = input.approvals.length > approvals.length
  const latest = approvals[approvals.length - 1]
  const active = latest && !latest.revokedAt && Date.parse(latest.expiresAt) > now ? latest : undefined
  const publication = active ? [...input.publications].reverse().find(item => item.approvalId === active.id) : undefined
  const state: AcceptanceState = publication?.status === 'succeeded' ? 'live'
    : publication?.status === 'failed' ? 'failed'
      : publication?.status === 'uncertain' ? 'checking'
        : publication ? 'publishing'
          : active ? 'approved'
            : latest?.revokedAt ? 'revoked'
              : latest ? 'expired'
                : input.stage === 'approval' ? 'pending'
                  : stale ? 'invalidated' : 'unavailable'
  return { state, active, publication }
}
