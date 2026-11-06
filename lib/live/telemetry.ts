import { LIVE_ID, LIVE_KINDS } from './events'
import type { LiveObservation } from './channel'

const keyFamilies = new Set(['coordinator-chat', 'coordinator-chat-metadata', 'bot-chats', 'threads', 'issue-thread', 'task-runs', 'issues', 'issue', 'versions', 'issue-activity-versions', 'issue-connections', 'deleted-issue', 'document-sync', 'bots', 'bot-list-groups', 'computer', 'groups', 'devices', 'approved-writes', 'approved-write', 'pending-actions', 'factory', 'factory-task', 'factory-issue', 'project-map'])

/** The family and stable digest identify a read without sending SWR's owner,
 * cursor, search text or query string. Entity IDs are separate UUID fields. */
export function liveReadKey(key: string): { read_key: string; read_key_hash: string } {
  const family = /^@?"?([a-z][a-z0-9:_-]{0,63})(?:"|,|$)/.exec(key)?.[1]
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  return { read_key: family && keyFamilies.has(family) ? family : 'other', read_key_hash: (hash >>> 0).toString(16).padStart(8, '0') }
}

export function liveTelemetry(observation: LiveObservation): { event: string; properties: Record<string, string | number> } {
  const properties: Record<string, string | number> = {}
  if (observation.state) properties.live_state = observation.state
  if (observation.reason) properties.live_reason = observation.reason
  if (observation.kind && LIVE_KINDS.includes(observation.kind)) properties.live_kind = observation.kind
  if (observation.id && LIVE_ID.test(observation.id)) properties.live_entity_id = observation.id
  if (observation.rev !== undefined && Number.isSafeInteger(observation.rev) && observation.rev > 0) properties.live_revision = observation.rev
  if (observation.key) Object.assign(properties, liveReadKey(observation.key))
  return { event: `mikka_live_${observation.event}`, properties }
}
