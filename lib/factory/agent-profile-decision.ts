/** Agent 配置 are content only and are never chosen automatically (decision
 * 2026-11-15-1630). What remains here is what frozen runs still carry. */
export interface PublicAgentProfileSkill { id: string; name: string; description: string; source: 'official' | 'personal' | 'workspace' | 'repository' }
/** What the Coordinator sees to name a Profile: its content summary only. */
export interface PublicAgentProfile {
  id: string; name: string; description: string
  /** Bounded metadata. Never a Skill body, private path, source revision or credential. */
  skills?: PublicAgentProfileSkill[]
}
/** Descriptive context from the locked Factory task, never an admission grant. */
export interface ProfileCheckWork {
  stage: 'review' | 'verify'
  flowVersion: 1 | 2
  taskId: string
  attemptId: string
  requestEpoch: string
  candidate: { id: string; kind: 'repository' | 'report' | 'deliverable'; sha: string | null }
  producer: { runId: string; harness: 'claude_code' | 'codex'; model: string | null; profile?: { id: string; version: number } }
}
/** Reason codes of selections frozen before 2026-11-15, for the identity UI. */
export const DECISION_REASONS = ['capability_fit', 'stage_fit', 'only_suitable'] as const
export type DecisionReason = typeof DECISION_REASONS[number]
/** Failure details recorded by the retired automatic selection; old attempts still show them. */
export type ProfileDecisionFailure = 'decision_unavailable' | 'no_suitable_profile' | 'invalid_profile_answer' | 'unknown_profile' | 'uncertain_profile' | 'invalid_reason'
