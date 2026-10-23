import { AsyncLocalStorage } from 'node:async_hooks'

// Who caused an issue_versions row. Always decided on the server from the
// verified session, MCP token or job that is running; never read from input.
export const ACTIVITY_ACTOR_TYPES = ['user', 'agent', 'system'] as const
export type ActivityActorType = typeof ACTIVITY_ACTOR_TYPES[number]
export type ActivityActor = { actorType: ActivityActorType; actorId: string | null }

export const userActor = (userId: string): ActivityActor => ({ actorType: 'user', actorId: userId })
export const agentActor = (agentId: string | null): ActivityActor => ({ actorType: 'agent', actorId: agentId })
export const systemActor = (source: string | null = null): ActivityActor => ({ actorType: 'system', actorId: source })

type ActingContext = { userId: string; actor?: ActivityActor }
export const actingContext = new AsyncLocalStorage<ActingContext>()

/**
 * The actor for a write done for `userId`: the actor set by `actAs` (an MCP
 * agent, say) when there is one, otherwise that signed-in person.
 */
export function activityActor(userId: string): ActivityActor {
  const context = actingContext.getStore()
  return context?.actor && context.userId === userId ? context.actor : userActor(userId)
}
