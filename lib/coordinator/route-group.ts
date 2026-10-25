import 'server-only'
import { decide } from '@/lib/coordinator/decide'
import { type GroupMessage, type GroupRoute, mentionRoute, routeFromAnswers, routingInput, routingQuestions, type RoutingCorrection, type RoutingMember } from '@/lib/coordinator/group-routing'

/**
 * Decides who answers a group-chat message: @mentions by rule, otherwise one
 * decision-model call, falling back to the Lead. Throws UnknownMentionError
 * when the message mentions a non-member.
 */
export async function routeGroupMessage(message: GroupMessage, members: readonly RoutingMember[], leadId: string, corrections: readonly RoutingCorrection[] = []): Promise<GroupRoute> {
  const mentioned = mentionRoute(message, members)
  if (mentioned) return mentioned
  if (members.length === 1) return { by: 'model', responders: [members[0].id], confidence: 1 }
  const answers = members.length ? await decide('group-routing', routingInput(message, members, corrections), routingQuestions(members)) : null
  return routeFromAnswers(answers, members, leadId)
}
