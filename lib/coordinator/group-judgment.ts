import { z } from 'zod'
import { checkedRoute, GroupJudgmentPendingError, type CorrectionInput, type CorrectionJudgment } from './group-correction'
import type { GroupMessage, RoutingCorrection, RoutingMember } from './group-routing'

// The provider is injected so the shared visual decision service can be wired
// without a second key, provider or billing configuration in this feature.
export type GroupJudge = (request: {
  kind: 'route' | 'correction'
  data: unknown
}) => Promise<unknown>

const routeResult = z.object({ kind: z.enum(['route', 'uncertain']), responders: z.array(z.string().uuid()).max(100), confidence: z.number().min(0).max(1) }).strict()
const correctionResult = z.object({ kind: z.enum(['correction', 'not_correction', 'uncertain']), rightId: z.string().uuid().nullable() }).strict()

export function createGroupJudgment(judge: GroupJudge) {
  return {
    async route(message: GroupMessage, members: RoutingMember[], leadId: string | null, corrections: RoutingCorrection[]) {
      try {
        const result = routeResult.parse(await judge({ kind: 'route', data: { message, members, leadId, corrections } }))
        return checkedRoute(result, members)
      } catch { throw new GroupJudgmentPendingError() }
    },
    async correction(input: CorrectionInput): Promise<CorrectionJudgment> {
      try {
        const result = correctionResult.parse(await judge({ kind: 'correction', data: input }))
        return result.kind === 'correction' ? { kind: result.kind, rightId: result.rightId } : { kind: result.kind }
      } catch { return { kind: 'uncertain' } }
    },
  }
}
