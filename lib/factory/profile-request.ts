import 'server-only'
import type { Pool } from 'pg'
import { AgentProfileError } from './agent-profile-definition'
import { agentProfileReferenceSchema, BUILTIN_AGENT_PROFILE_ID } from './agent-profile-reference'
import { readProfileRow } from './agent-profile-store'
import { taskDestinationSchema, type TaskDestination } from '../task-destination'

/** A selection from the owner's task form is authoritative. A model may carry
 * an explicitly named profile, but cannot manufacture an explicit user pin. */
export async function requestedTaskSelection(pool: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string; botId: string },
  eventId: string | undefined, offered: string | undefined): Promise<{ profileId?: string; taskDestination?: TaskDestination }> {
  if (!eventId) {
    if (offered) throw new AgentProfileError('agentProfilePinConflict')
    return {}
  }
  const { rows: [event] } = await pool.query(`SELECT payload FROM coordinator_events
    WHERE id=$1 AND "userId"=$2 AND "botId"=$3 AND kind='user_message'`, [eventId, scope.ownerId, scope.botId])
  // Reuse the authenticated source read. Placement must not depend on the
  // model repeating the person's task-form choice in its tool arguments.
  const destination = taskDestinationSchema.safeParse(event?.payload?.taskDestination)
  const selection = destination.success ? { taskDestination: destination.data } : {}
  const selected = agentProfileReferenceSchema.safeParse(event?.payload?.profileId)
  if (selected.success) return { ...selection, profileId: selected.data }
  if (!offered) return selection
  // The built-in route requires the structured task-form choice. Neither a
  // model's tool parameter nor matching words can bypass Automatic selection.
  if (!event || offered === BUILTIN_AGENT_PROFILE_ID) throw new AgentProfileError('agentProfilePinConflict')
  const profile = await readProfileRow(pool, scope, offered)
  const words = typeof event.payload?.text === 'string' ? event.payload.text.normalize('NFKC').toLocaleLowerCase() : ''
  if (!words.includes(profile.id.toLowerCase()) && !words.includes(profile.definition.name.normalize('NFKC').toLocaleLowerCase())) throw new AgentProfileError('agentProfilePinConflict')
  return { ...selection, profileId: profile.id }
}

/** Existing Profile-only callers keep their result and one source read. */
export async function requestedAgentProfile(pool: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string; botId: string },
  eventId: string | undefined, offered: string | undefined): Promise<string | undefined> {
  return (await requestedTaskSelection(pool, scope, eventId, offered)).profileId
}
