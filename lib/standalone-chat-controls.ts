import { withConversationWorkspace } from './conversation-workspace'
import { conversationTargetInput, type ConversationTarget } from './conversation-directory-input'
import type { ConversationOrganizationChange } from './conversation-organization'
import type { RunChainQueryable } from './run-chain'

const ownerScope = `c.id=$1 AND c."createdBy"=$2 AND c."workspaceId"=$3
  AND c.kind='group' AND c."creationPurpose"='conversation'
  AND EXISTS (SELECT 1 FROM conversation_members m WHERE m."conversationId"=c.id
    AND m."memberType"='user' AND m."memberId"=$2 AND m."leftAt" IS NULL)`

/** Resolve released, untyped addresses in one statement against both owner-scoped identities. */
export async function resolveConversationTarget(database: RunChainQueryable, target: ConversationTarget, owner: string, workspace: string) {
  const parsed = conversationTargetInput.safeParse(target)
  if (!parsed.success) return null
  if (typeof parsed.data !== 'string') return parsed.data
  const id = parsed.data
  return withConversationWorkspace(owner, workspace, async () => {
    const { rows } = await database.query(`SELECT 'run' AS kind FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3
      UNION ALL SELECT 'chat' AS kind FROM conversations c WHERE ` + ownerScope, [id, owner, workspace])
    if (rows.length !== 1) return null
    return { kind: rows[0].kind as 'run' | 'chat', id }
  })
}

export async function standaloneOrganization(database: RunChainQueryable, id: string, owner: string, workspace: string, change?: ConversationOrganizationChange) {
  return withConversationWorkspace(owner, workspace, async () => {
    const keys = [id, owner, workspace]
    if (change) {
      const column = change.field === 'archived' ? '"conversationArchivedAt"' : '"conversationPinnedAt"'
      const restore = change.field === 'archived' && !change.value ? ', "conversationRestoredAt"=now()' : ''
      const update = await database.query('UPDATE conversations c SET ' + column + '=CASE WHEN $4 THEN coalesce(' + column + ',now()) END' + restore +
        ' WHERE ' + ownerScope + ' RETURNING id', [...keys, change.value])
      if (!update.rows.length) return null
    }
    const { effectiveStandaloneOrganization } = await import('./conversation-directory')
    return effectiveStandaloneOrganization(database, owner, workspace, id)
  })
}

export async function renameStandalone(database: RunChainQueryable, id: string, owner: string, workspace: string, title: string) {
  return await withConversationWorkspace(owner, workspace, async () => {
    const { rows } = await database.query('UPDATE conversations c SET title=$4 WHERE ' + ownerScope + ' RETURNING c.title', [id, owner, workspace, title])
    return rows[0]?.title as string | undefined
  }) ?? undefined
}

export async function regenerateStandalone(database: RunChainQueryable, id: string, owner: string, workspace: string,
  generate: (owner: string, content: {title: string; body: string}, workspace: string) => Promise<string | null>) {
  const keys = [id, owner, workspace]
  const snapshot = await withConversationWorkspace(owner, workspace, () => database.query(`SELECT c.title,c.xmin::text AS version,
    coalesce((SELECT left(m.body,800) FROM conversation_messages m
      WHERE m."conversationId"=c.id AND m."authorId"=$2 AND m."authorType"='user' ORDER BY m.position LIMIT 1),'') AS body
    FROM conversations c WHERE ` + ownerScope, keys))
  if (!snapshot?.rows[0]) return null
  const old = snapshot.rows[0] as {title:string;version:string;body:string}
  const next = await generate(owner, { title:old.title, body:old.body }, workspace)
  return withConversationWorkspace(owner, workspace, async () => {
    if (next) {
      const updated = await database.query('UPDATE conversations c SET title=$4 WHERE ' + ownerScope + ' AND c.xmin::text=$5 RETURNING c.title', [...keys, next, old.version])
      if (updated.rows[0]) return {title: next, regenerated: true}
    }
    // A concurrent rename or loss of membership can arrive while the model runs.
    const current = await database.query('SELECT c.title FROM conversations c WHERE '+ownerScope, keys)
    return current.rows[0] ? {title: String(current.rows[0].title), regenerated:false} : null
  })
}
