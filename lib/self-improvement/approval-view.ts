type Approval = { id: string; candidateId: string; action: string; revokedAt: string | null; expiresAt: string; targetEnvironment: string }
type Publication = { approvalId: string; candidateId: string; action: string; status: string; receipt: unknown }

export function hasRecordedSkillActivation(candidateId: string | null, approvals: Approval[], publications: Publication[]) {
  return publications.some(publication => publication.candidateId === candidateId && publication.action === 'activate_skill' && publication.status === 'succeeded' && !!publication.receipt && approvals.some(approval => approval.id === publication.approvalId && approval.candidateId === candidateId && approval.action === 'activate_skill' && !approval.revokedAt))
}

export function currentSkillApproval(candidateId: string | null, approvals: Approval[], now: number) {
  return [...approvals].reverse().find(approval => approval.candidateId === candidateId && approval.action === 'activate_skill' && !approval.revokedAt && new Date(approval.expiresAt).getTime() > now)
}
