import type { GroupMessage, GroupRoute, RoutingCorrection, RoutingMember } from './group-routing'

export class GroupJudgmentPendingError extends Error { constructor() { super('group_judgment_pending') } }

export type CorrectionJudgment =
  | { kind: 'correction'; rightId: string | null }
  | { kind: 'not_correction' | 'uncertain' }

/** Validate model output against the actual members; invalid output is never a fact. */
export function checkedCorrection(
  judgment: CorrectionJudgment, previous: { message: string; responderId: string }, members: readonly RoutingMember[],
): RoutingCorrection | null | 'uncertain' {
  if (judgment.kind === 'uncertain') return 'uncertain'
  if (judgment.kind === 'not_correction') return null
  if (!members.some(member => member.id === previous.responderId)) return 'uncertain'
  if (judgment.rightId && (judgment.rightId === previous.responderId || !members.some(member => member.id === judgment.rightId))) return 'uncertain'
  return { message: previous.message, wrongId: previous.responderId, ...(judgment.rightId ? { rightId: judgment.rightId } : {}) }
}

export type CorrectionInput = { previous: { message: string; responderId: string }; current: GroupMessage; members: readonly RoutingMember[] }

/** Model chooses semantics; code checks only membership and structural integrity. */
export function checkedRoute(value: { kind: 'route' | 'uncertain'; responders: string[]; confidence: number }, members: readonly RoutingMember[]): GroupRoute {
  const { kind, responders, confidence } = value
  if (kind !== 'route' || !responders.length || new Set(responders).size !== responders.length || responders.some(id => !members.some(member => member.id === id)) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new GroupJudgmentPendingError()
  return { by: 'model', responders, confidence }
}
