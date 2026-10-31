/** Client view of a Factory acceptance (R-56). Pure so every state is testable without a server. */
export type AcceptanceState = 'pending' | 'approved' | 'publishing' | 'checking' | 'failed' | 'live' | 'revoked' | 'expired' | 'invalidated' | 'unavailable'
export type AcceptanceApproval = { id: string; candidateId: string; expiresAt: string; revokedAt: string | null; createdAt: string }
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
}): { state: AcceptanceState; active?: AcceptanceApproval; publication?: AcceptancePublication; superseded?: AcceptanceApproval } {
  // Precedence (R-56):
  // 1. Only approvals on the current candidate count; the latest of them decides
  //    (a newer revoke beats an older valid approval, a newer approval beats an older revoke).
  // 2. An approved publication survives the legacy grant timestamp. Only old
  //    approvals without a reservation still use their old expiry display.
  //    "Latest" is by createdAt, not by array order; ties keep the ledger's order.
  // 3. With no current candidate (candidateId null) no approval counts.
  // 4. Approvals on an older candidate never count. As on GitHub, a new commit voids the old
  //    approval: with no approval on the current candidate it is back to pending (待启用 /
  //    待你确认) and the old approval is returned as `superseded` (shown as 「<sha> · 已失效」).
  //    With no current candidate at all nothing can be approved: unavailable.
  const { now } = input
  const time = (approval: AcceptanceApproval) => { const value = Date.parse(approval.createdAt); return Number.isNaN(value) ? -Infinity : value }
  const approvals = input.approvals
    .map((approval, index) => ({ approval, index }))
    .filter(({ approval }) => input.candidateId !== null && approval.candidateId === input.candidateId)
    .sort((a, b) => time(a.approval) - time(b.approval) || a.index - b.index)
    .map(({ approval }) => approval)
  const superseded = input.candidateId === null ? undefined : input.approvals
    .filter(approval => approval.candidateId !== input.candidateId)
    .reduce<AcceptanceApproval | undefined>((last, approval) => !last || time(approval) >= time(last) ? approval : last, undefined)
  const latest = approvals[approvals.length - 1]
  const latestPublication = latest ? [...input.publications].reverse().find(item => item.approvalId === latest.id) : undefined
  const active = latest && !latest.revokedAt && (latestPublication || Date.parse(latest.expiresAt) > now) ? latest : undefined
  const publication = active ? latestPublication : undefined
  const state: AcceptanceState = publication?.status === 'succeeded' ? 'live'
    : publication?.status === 'failed' ? input.stage === 'approval' ? 'pending' : 'failed'
      : publication?.status === 'uncertain' ? 'checking'
        : publication ? 'publishing'
          : active ? 'approved'
            : latest?.revokedAt ? 'revoked'
              : latest ? 'expired'
                : input.stage === 'approval' || superseded ? 'pending'
                  : 'unavailable'
  return { state, active, publication, superseded: latest ? undefined : superseded }
}
