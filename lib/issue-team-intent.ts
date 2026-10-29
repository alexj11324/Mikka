export type ExplicitTeamChoice = { issueId: string; teamId: string; selectionId: string }
type PromotionInput = { requestId: string; issueId: string; revision: number; teamId: string; expectedTeamId: string | null }
export type TeamPromotionIntent = { selectionId: string; input: PromotionInput }

/** Only a successful explicit team-save event supplies choice. A persisted
 * relation, cached workspace or previous task is not a new sharing instruction. */
export function prepareTeamPromotion(task: { id: string; revision: number }, choice: ExplicitTeamChoice | null | undefined, expectedTeamId: string | null | undefined, previous: TeamPromotionIntent | null, requestId: () => string) {
  if (!choice || choice.issueId !== task.id || !choice.teamId || !choice.selectionId) return { error: 'issueScopeTeamRequired' as const }
  if (expectedTeamId !== choice.teamId) return { error: 'teamIssueChanged' as const }
  if (previous?.selectionId === choice.selectionId) {
    const input = previous.input
    if (input.issueId !== task.id || input.revision !== task.revision || input.teamId !== choice.teamId || input.expectedTeamId !== expectedTeamId) return { error: 'teamIssueChanged' as const }
    return { intent: previous }
  }
  return { intent: { selectionId: choice.selectionId, input: Object.freeze({ requestId: requestId(), issueId: task.id, revision: task.revision, teamId: choice.teamId, expectedTeamId }) } }
}

/** A cancelled choice must be checked after the relation read, before the
 * server action is sent, and before its result is adopted by the current UI. */
export async function submitTeamPromotion<T>(task: { id: string; revision: number }, choice: ExplicitTeamChoice | null | undefined, previous: TeamPromotionIntent | null, deps: {
  isCurrent: () => boolean
  readTeam: () => Promise<string | null>
  requestId: () => string
  remember: (intent: TeamPromotionIntent) => void
  promote: (input: PromotionInput) => Promise<T>
}) {
  if (!choice || choice.issueId !== task.id || !choice.teamId || !choice.selectionId) return { error: 'issueScopeTeamRequired' as const }
  if (!deps.isCurrent()) return { error: 'teamIssueChanged' as const }
  const currentTeam = await deps.readTeam()
  if (!deps.isCurrent()) return { error: 'teamIssueChanged' as const }
  const prepared = prepareTeamPromotion(task, choice, currentTeam, previous, deps.requestId)
  if ('error' in prepared) return prepared
  deps.remember(prepared.intent)
  const result = await deps.promote(prepared.intent.input)
  if (!deps.isCurrent()) return { error: 'teamIssueChanged' as const }
  return result
}
