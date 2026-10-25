import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users, agents } from '@/lib/db/schema'
import { activityActorView, type StoredActivityActor } from './activity-actor-view'

/** Only call after authorizing the issue/history. Actor ids cannot grant access. */
export async function enrichActivityActors<T extends StoredActivityActor>(versions: T[], ownerId: string) {
  const userIds = [...new Set(versions.filter(row => row.actorType === 'user' && row.actorId).map(row => row.actorId!))]
  const agentIds = [...new Set(versions.filter(row => row.actorType === 'agent' && row.actorId).map(row => row.actorId!))]
  // OAuth client ids are not necessarily UUIDs and must not be queried as agents.id.
  const uuidAgents = agentIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  const [people, ownedAgents] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.name, avatarUrl: users.image }).from(users).where(inArray(users.id, userIds)) : [],
    uuidAgents.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.userId, ownerId), inArray(agents.id, uuidAgents))) : [],
  ])
  return versions.map(row => ({ ...row, actor: activityActorView(row, people, ownedAgents.map(agent => ({ ...agent, avatarUrl: null }))) }))
}
