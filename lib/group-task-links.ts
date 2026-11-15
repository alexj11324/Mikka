import 'server-only'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { DirectoryTaskLink } from './conversation-directory-input'
import type { GroupTaskReference } from './coordinator/group-routing'
import { issues } from './db/schema'
import { issueVisibilityPredicate } from './issue-visibility-policy'
import type { RunChainQueryable } from './run-chain'
import { workspacePool } from './workspace-db'
import { requireTaskWorkspaceLease } from './task-workspace'

const dialect = new PgDialect()

/** The caller holds the Workspace lease. A binding never grants access to its Task or Chat. */
function authorizedBindings(owner: string, workspace: string, chatIds: string[], namedOnly: boolean) {
  requireTaskWorkspaceLease(owner, workspace)
  const visibility = issueVisibilityPredicate(owner, { allowedIds: [], workspaceIds: [workspace] })
  return sql`FROM group_task_bindings b JOIN conversations c ON c.id=b."conversationId"
    JOIN conversation_members m ON m."conversationId"=c.id AND m."memberType"='user' AND m."memberId"=${owner} AND m."leftAt" IS NULL
    JOIN ${issues} ON ${issues.id}=b."issueId"
    WHERE c.id=ANY(${sql.param(chatIds)}::uuid[]) AND c."workspaceId"=${workspace} AND c.kind='group'
      AND ${namedOnly ? sql`c."creationPurpose"='conversation' AND c."createdBy"=${owner}` : sql`(c."creationPurpose"='group' OR c."createdBy"=${owner})`}
      AND b."userId"=${owner} AND ${visibility}
      AND coalesce(nullif(${issues.content}->'attrs'->'mikka','null'::jsonb),${issues.content}->'attrs'->'orvilo')->>'deletedAt' IS NULL`
}

/** Team rows live in WS. As in Task detail, a stale cross-tenant link disqualifies the APP row. */
async function conflictsFor(ids: string[], workspaceId: string) {
  if (!ids.length) return new Set<string>()
  const { rows } = await workspacePool.query<{ issueId: string }>(
    'SELECT "issueId" FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[]) AND "workspaceId"<>$2', [[...new Set(ids)], workspaceId])
  return new Set(rows.map(row => row.issueId))
}

export async function linkedTasksForChats(database: RunChainQueryable, owner: string, workspace: string, ids: string[]) {
  const byChat = new Map<string, DirectoryTaskLink[]>()
  if (!ids.length) return byChat
  const statement = dialect.sqlToQuery(sql`
    SELECT c.id AS "chatId", ${issues.id} AS id, ${issues.issuedIdentifier} AS identifier, ${issues.title} AS title
    ${authorizedBindings(owner, workspace, [...new Set(ids)], true)}
    ORDER BY c.id,b."createdAt" DESC,${issues.id}`)
  const bindings = (await database.query(statement.sql, statement.params)).rows as (DirectoryTaskLink & { chatId: string })[]
  const hidden = await conflictsFor(bindings.map(row => row.id), workspace)
  for (const { chatId, id, identifier, title } of bindings) {
    if (hidden.has(id)) continue
    const links = byChat.get(chatId) ?? []
    links.push({ id, identifier, title })
    byChat.set(chatId, links)
  }
  return byChat
}

/** Admit at most the most recent 20 Task references before resolving any Factory state. */
export async function decisionTaskReferences(database: RunChainQueryable, userId: string, workspaceId: string, conversationId: string) {
  const statement = dialect.sqlToQuery(sql`
    WITH recent AS (
      SELECT b."issueId",b."reporterId",b."userId",b."executionBotId",b."createdAt",${issues.title} AS title
      ${authorizedBindings(userId, workspaceId, [conversationId], false)}
      ORDER BY b."createdAt" DESC,b."issueId" LIMIT 20
    )
    SELECT r."issueId",r."reporterId",r.title,t.id AS "taskId",coalesce(t.status,'pending') AS status,
      a."runId",t."sourceEventId" AS "requestEpoch"
    FROM recent r LEFT JOIN LATERAL (SELECT * FROM factory_tasks WHERE "issueId"=r."issueId" AND "userId"=r."userId"
      AND "botId"=r."executionBotId" AND "workspaceId"=${workspaceId} ORDER BY "createdAt" DESC,id LIMIT 1) t ON true
    LEFT JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    ORDER BY r."createdAt" DESC,r."issueId"`)
  const rows = (await database.query(statement.sql, statement.params)).rows as unknown as GroupTaskReference[]
  const hidden = await conflictsFor(rows.map(row => row.issueId), workspaceId)
  return rows.filter(row => !hidden.has(row.issueId))
}
