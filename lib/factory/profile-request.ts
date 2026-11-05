import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { AgentProfileError } from './agent-profile-definition'
import { readProfileRow } from './agent-profile-store'

/** A selection from the owner's task form is authoritative. A model may carry
 * an explicitly named profile, but cannot manufacture an explicit user pin. */
export async function requestedAgentProfile(pool: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string; botId: string },
  eventId: string | undefined, offered: string | undefined): Promise<string | undefined> {
  if (!eventId) {
    if (offered) throw new AgentProfileError('agentProfilePinConflict')
    return undefined
  }
  const { rows: [event] } = await pool.query(`SELECT payload FROM coordinator_events
    WHERE id=$1 AND "userId"=$2 AND "botId"=$3 AND kind='user_message'`, [eventId, scope.ownerId, scope.botId])
  const selected = z.uuid().safeParse(event?.payload?.profileId)
  if (selected.success) return selected.data
  if (!offered) return undefined
  if (!event) throw new AgentProfileError('agentProfilePinConflict')
  const profile = await readProfileRow(pool, scope, offered)
  const words = typeof event.payload?.text === 'string' ? event.payload.text.normalize('NFKC').toLocaleLowerCase() : ''
  if (!words.includes(profile.id.toLowerCase()) && !words.includes(profile.definition.name.normalize('NFKC').toLocaleLowerCase())) throw new AgentProfileError('agentProfilePinConflict')
  return profile.id
}
