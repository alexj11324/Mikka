import { effectiveConversationArchive } from './conversation-directory'
import { readRunChain, type RunChainQueryable } from './run-chain'

export type ConversationOrganization = { archived: boolean; pinned: boolean }
export type ConversationOrganizationChange = { field: 'archived' | 'pinned'; value: boolean }

/** Every attempt addresses its root. The persisted owner and the selected workspace fence both reads and writes. */
export async function conversationOrganization(
  database: RunChainQueryable,
  ownerId: string,
  workspaceId: string,
  runId: string,
  change?: ConversationOrganizationChange,
): Promise<ConversationOrganization | null> {
  const chain = await readRunChain(database, ownerId, runId)
  if (!chain) return null
  const projection = '"conversationArchivedAt" IS NOT NULL AS archived, "conversationPinnedAt" IS NOT NULL AS pinned'
  const scope = 'id = $1 AND "userId" = $2 AND "workspaceId" = $3'
  const keys = [chain.rootRunId, ownerId, workspaceId]
  if (!change) {
    const { rows } = await database.query('SELECT ' + projection + ' FROM agent_runs WHERE ' + scope, keys)
    const row = rows[0] as ConversationOrganization | undefined
    if (!row) return null
    const archived = await effectiveConversationArchive(database, ownerId, workspaceId, chain.rootRunId)
    return archived === null ? null : { archived, pinned: row.pinned }
  }
  if (await effectiveConversationArchive(database, ownerId, workspaceId, chain.rootRunId) === null) return null
  // A replay after a lost acknowledgement keeps the original pin or archive date.
  const column = change.field === 'archived' ? '"conversationArchivedAt"' : '"conversationPinnedAt"'
  const { rows } = await database.query(
    'UPDATE agent_runs SET ' + column + ' = CASE WHEN $4 THEN coalesce(' + column + ', now()) END' +
      (change.field === 'archived' && !change.value ? ', "conversationRestoredAt"=now()' : '') + ' WHERE ' + scope + ' RETURNING ' + projection,
    [...keys, change.value],
  )
  const row = rows[0] as ConversationOrganization | undefined
  if (!row) return null
  const archived = await effectiveConversationArchive(database, ownerId, workspaceId, chain.rootRunId)
  return archived === null ? null : { archived, pinned: row.pinned }
}
