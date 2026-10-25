import type { ActivityActorType } from './activity-actor'

export type ActivityActorView = { type: ActivityActorType; id: string | null; name: string | null; avatarUrl: string | null }
export type StoredActivityActor = { actorType: ActivityActorType | null; actorId: string | null }
export type ActorIdentity = { id: string; name: string; avatarUrl: string | null }

/** Missing/deleted identities keep their stable type/id, never become the viewer. */
export function activityActorView(row: StoredActivityActor, users: ActorIdentity[], agents: ActorIdentity[]): ActivityActorView | null {
  if (!row.actorType) return null
  const identity = (row.actorType === 'user' ? users : row.actorType === 'agent' ? agents : []).find(actor => actor.id === row.actorId)
  return { type: row.actorType, id: row.actorId, name: identity?.name ?? null, avatarUrl: identity?.avatarUrl ?? null }
}
