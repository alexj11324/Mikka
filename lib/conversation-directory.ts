import 'server-only'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { directoryInput, type DirectoryInput, type DirectoryState, type ConversationDirectoryPage } from './conversation-directory-input'
import { runAwaitingApproval, runDeviceOffline } from './task-state-query'
import { conversationReads, agentRuns } from './db/schema'
import { joinThreadRead, threadUnread } from './thread-reads'
import { runFailureBrief } from './run-failure-projection'
import { runChainSql, RUN_CHAIN_MAX_DEPTH, type RunChainQueryable } from './run-chain'
import { attemptStateOf, type TaskStateRun } from './task-state'
import { threadName } from './issue-threads'
import { conversationTitle } from './short-title'

type Row = TaskStateRun & {
  id: string; issueId: string | null; identifier: string | null; title: string | null; asked: string
  taskTitle: string | null; agentName: string; pinned: boolean; unread: boolean; at: string
}

function directoryState(row: Row): DirectoryState {
  switch (attemptStateOf(row)) {
    case 'blocked': case 'paused': return 'waiting'
    case 'running': return 'working'
    case 'failed': return 'failed'
    default: return 'idle'
  }
}

/** The detail reader allows the run owner in their active workspace; attached tasks also require current content access.
 * Resolve chains before paging, so a continued conversation appears only once and older task-free work remains reachable. */
export async function conversationDirectory(database: RunChainQueryable, userId: string, workspaceId: string, raw: DirectoryInput): Promise<ConversationDirectoryPage> {
  const input = directoryInput.parse(raw)
  const projection = sql`SELECT roots.id, roots.title, roots.asked, roots."agentName", roots.pinned, roots.at,
      roots."issueId", roots.identifier, roots."taskTitle",
      EXISTS (SELECT 1 FROM assigned receipt JOIN ${agentRuns} ON ${agentRuns.id}=receipt.id
        LEFT JOIN ${conversationReads} ON ${joinThreadRead(userId)}
        WHERE receipt.root=roots.id AND NOT receipt."depthExceeded" AND (${threadUnread})) AS unread,
      agent_runs.id AS "runId", agent_runs.status, agent_runs.outcome, agent_runs."pauseReason", agent_runs."stopReason",
      agent_runs."threadReplacedBy", ${runFailureBrief} AS "failureDetails", (${runAwaitingApproval}) AS "awaitingApproval",
      (${runDeviceOffline}) AS "deviceOffline" FROM roots JOIN agent_runs ON agent_runs.id=roots.latest`
  const query = new PgDialect().sqlToQuery(projection)
  const param = (i: number) => '$' + (query.params.length + i)
  const [owner, workspace, depth, archived, bot, pinCursor, atCursor, idCursor, search] = Array.from({ length: 9 }, (_, i) => param(i + 1))
  const scope = `r."userId"=${owner} AND r."workspaceId"=${workspace} AND EXISTS (
    SELECT 1 FROM mikka_workspace_members m WHERE m."workspaceId"=r."workspaceId" AND m."userId"=r."userId" AND m.status='active')`
  const statement = `WITH RECURSIVE ${runChainSql(scope, depth)}, latest AS (
      SELECT DISTINCT ON (a.root) a.root,r.id,
        max(greatest(r."lastReplyAt",r."updatedAt",r."createdAt")) OVER (PARTITION BY a.root) AS touched
      FROM assigned a JOIN agent_runs r ON r.id=a.id WHERE NOT a."depthExceeded"
      ORDER BY a.root,r."createdAt" DESC,r.id DESC
    ), roots AS (
      SELECT root.id,latest.id AS latest, coalesce(current.title,root.title) AS title,
        agent.name AS "agentName", root."conversationPinnedAt" IS NOT NULL AS pinned,
        to_char(latest.touched AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        root."issueId",i."issuedIdentifier" AS identifier,i.title AS "taskTitle",
        CASE WHEN root."promptTaskStart">=0 AND root."promptTaskLength" BETWEEN 0 AND length(root.prompt)-root."promptTaskStart"::bigint
          THEN left(substr(root.prompt,root."promptTaskStart"+1,root."promptTaskLength"),400) ELSE '' END AS asked
      FROM latest JOIN agent_runs root ON root.id=latest.root JOIN agent_runs current ON current.id=latest.id
      JOIN agents agent ON agent.id=root."agentId"
      LEFT JOIN issues i ON i.id=root."issueId" AND i."workspaceId"=root."workspaceId" AND i."ownershipState"='bound'
        AND coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' IS NULL
        AND mikka_resource_acl_allowed('account',${owner},i."workspaceId",'task',i.id,'canReadContent')
      WHERE (root."issueId" IS NULL OR i.id IS NOT NULL)
        AND (root."conversationArchivedAt" IS NOT NULL)=${archived}
        AND (${bot}::uuid IS NULL OR root."botId"=${bot})
        AND (${search}::text = '' OR strpos(lower(coalesce(current.title, root.title,
          CASE WHEN root."promptTaskStart">=0 AND root."promptTaskLength" BETWEEN 0 AND length(root.prompt)-root."promptTaskStart"::bigint
            THEN nullif(left(trim(substr(root.prompt,root."promptTaskStart"+1,root."promptTaskLength")),400),'') END, i.title,agent.name)),lower(${search}))>0)
        AND (${idCursor}::uuid IS NULL OR (root."conversationPinnedAt" IS NOT NULL,latest.touched,root.id)
          < (${pinCursor}::boolean,${atCursor}::timestamptz,${idCursor}::uuid))
      ORDER BY pinned DESC,latest.touched DESC,root.id DESC LIMIT 101
    ) ${query.sql} ORDER BY roots.pinned DESC,roots.at DESC,roots.id DESC`
  const rows = (await database.query(statement, [...query.params, userId, workspaceId, RUN_CHAIN_MAX_DEPTH, input.archived,
    input.botId ?? null, input.cursor?.pinned ?? null, input.cursor?.at ?? null, input.cursor?.id ?? null, input.search])).rows as Row[]
  const batch = rows.slice(0, 100)
  const items = batch.map(row => ({
    id: row.id, issueId: row.issueId, identifier: row.identifier, title: conversationTitle({ title: row.title,
      name: threadName(row.asked, ''), issue: { title: row.taskTitle || row.agentName } }),
    state: directoryState(row), at: row.at, pinned: row.pinned, unread: row.unread,
  })).filter(item => (input.state === 'all' || item.state === input.state) &&
    (!input.search || item.title.toLowerCase().includes(input.search.toLowerCase())))
  const last = batch.at(-1)
  return { items, cursor: rows.length > batch.length && last ? { id: last.id, at: last.at, pinned: last.pinned } : null }
}
