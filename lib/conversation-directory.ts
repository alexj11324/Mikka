import 'server-only'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { directoryInput, type DirectoryInput, type DirectoryState } from './conversation-directory-input'
import { runAwaitingApproval, runDeviceOffline } from './task-state-query'
import { threadUnread } from './thread-reads'
import { runBotId } from './run-bot-name'
import { runChainSql, RUN_CHAIN_MAX_DEPTH, type RunChainQueryable } from './run-chain'
import { threadName } from './issue-threads'
import { conversationTitle } from './short-title'

type Row = {
  id: string; issueId: string | null; identifier: string | null; title: string | null; asked: string
  taskTitle: string | null; agentName: string; pinned: boolean; at: string; state: DirectoryState
  botId: string | null; status: string | null; harness: string | null; position: number; unread: boolean
}

// Both readers resolve exactly one authorized conversation per root. A pin or
// live question survives the idle threshold. A manual restore restarts its clock.
const dialect = new PgDialect()
const facts = dialect.sqlToQuery(sql`SELECT (${runAwaitingApproval}) AS approval, (${runDeviceOffline}) AS offline`)
const unread = dialect.sqlToQuery(threadUnread)
const attribution = dialect.sqlToQuery(sql`SELECT ${runBotId} AS id`)

function conversationQuery() {
  const owner = '$' + (facts.params.length + 1), workspace = '$' + (facts.params.length + 2)
  const depth = '$' + (facts.params.length + 3)
  const scope = `r."userId"=${owner} AND r."workspaceId"=${workspace} AND EXISTS (
    SELECT 1 FROM mikka_workspace_members m WHERE m."workspaceId"=r."workspaceId" AND m."userId"=r."userId" AND m.status='active')`
  return `WITH RECURSIVE ${runChainSql(scope,depth)}, latest AS (
    SELECT DISTINCT ON (a.root) a.root,r.id,
      max(greatest(r."lastReplyAt",r."updatedAt",r."createdAt")) OVER (PARTITION BY a.root) AS touched
    FROM assigned a JOIN agent_runs r ON r.id=a.id WHERE NOT a."depthExceeded"
    ORDER BY a.root,r."createdAt" DESC,r.id DESC
  ), roots AS (
    SELECT root.id,EXISTS (SELECT 1 FROM assigned receipt JOIN agent_runs ON agent_runs.id=receipt.id
      LEFT JOIN conversation_reads ON conversation_reads."userId"=${owner} AND conversation_reads."conversationId"='run:' || agent_runs.id::text
      WHERE receipt.root=root.id AND NOT receipt."depthExceeded" AND (${unread.sql})) AS unread, coalesce(agent_runs.title,root.title) AS title, agents.name AS "agentName",agents.harness,
      root."issueId",i."issuedIdentifier" AS identifier,i.title AS "taskTitle",i.status,agent_runs.status AS "runStatus",
      root."conversationPinnedAt" IS NOT NULL AS pinned,root."conversationArchivedAt" AS manual,
      root."conversationRestoredAt" AS restored,latest.touched,root.source,
      CASE WHEN root."promptTaskStart">=0 AND root."promptTaskLength" BETWEEN 0 AND length(root.prompt)-root."promptTaskStart"::bigint
        THEN left(substr(root.prompt,root."promptTaskStart"+1,root."promptTaskLength"),400) ELSE '' END AS asked,
      bot.id AS "botId", coalesce(pref."archiveIdleAfterDays",30) AS days,
      CASE WHEN agent_runs."threadReplacedBy" IS NOT NULL THEN 'idle'
        WHEN f.offline OR agent_runs."stopReason" IN ('device_lost','quota_exhausted') OR agent_runs.status IN ('waiting_input','paused')
          OR agent_runs."failureDetails"->>'category' IN ('quota','subscription','api_key','access_denied')
          OR agent_runs."failureDetails"->>'code'='run_quota_exceeded' OR agent_runs.outcome='blocked' OR f.approval THEN 'waiting'
        WHEN agent_runs.status IN ('queued','preparing','running','finishing') THEN 'working'
        WHEN agent_runs.outcome='needs_input' THEN 'waiting'
        WHEN agent_runs.status='failed' OR agent_runs.outcome='failed' THEN 'failed'
        ELSE 'idle' END AS state
    FROM latest JOIN agent_runs root ON root.id=latest.root JOIN agent_runs ON agent_runs.id=latest.id
    JOIN agents ON agents.id=root."agentId"
    LEFT JOIN issues i ON i.id=root."issueId" AND i."workspaceId"=root."workspaceId" AND i."ownershipState"='bound'
      AND coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' IS NULL
      AND mikka_resource_acl_allowed('account',${owner},i."workspaceId",'task',i.id,'canReadContent')
    LEFT JOIN user_preferences pref ON pref."userId"=${owner}
    CROSS JOIN LATERAL (${facts.sql}) f
    LEFT JOIN LATERAL (SELECT matched.id FROM agent_runs JOIN agents ON agents.id=agent_runs."agentId"
      CROSS JOIN LATERAL (${attribution.sql}) resolved JOIN bots matched ON matched.id=resolved.id
        AND matched."workspaceId"=${workspace} AND matched."ownerId"=${owner}
      WHERE agent_runs.id=root.id LIMIT 1) bot ON true
    WHERE root."issueId" IS NULL OR i.id IS NOT NULL
  ), visible AS (
    SELECT *,to_char(touched AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      (manual IS NOT NULL OR (days>0 AND NOT pinned AND state='idle' AND greatest(touched,restored)<now()-days*interval '1 day')) AS archived
    FROM roots
  )`
}

export async function effectiveConversationArchive(database: RunChainQueryable, userId: string, workspaceId: string, rootId: string) {
  const result = await database.query(conversationQuery() + ' SELECT archived FROM visible WHERE id=$' + (facts.params.length+4),
    [...facts.params,userId,workspaceId,RUN_CHAIN_MAX_DEPTH,rootId])
  return result.rows[0] ? Boolean(result.rows[0].archived) : null
}

function item(row: Row) {
  return { id: row.id, issueId: row.issueId, identifier: row.identifier, title: conversationTitle({ title: row.title,
    name: threadName(row.asked, ''), issue: { title: row.taskTitle || row.agentName } }), state: row.state, unread:row.unread, at: row.at, pinned: row.pinned }
}

export async function conversationDirectory(database: RunChainQueryable, userId: string, workspaceId: string, raw: DirectoryInput) {
  const input = directoryInput.parse(raw)
  const param = (i: number) => '$' + (facts.params.length + i)
  const [archived,bot,search,state,id,pinned,at] = Array.from({length:7}, (_,i) => param(4+i))
  const statement = conversationQuery() + ` SELECT * FROM visible WHERE archived=${archived}
    AND (${bot}::uuid IS NULL OR "botId"=${bot}) AND (${state}='all' OR state=${state})
    AND (${search}='' OR strpos(lower(coalesce(title,nullif(trim(asked),''),"taskTitle","agentName")),lower(${search}))>0)
    AND (${id}::uuid IS NULL OR (pinned,touched,visible.id)<(${pinned}::boolean,${at}::timestamptz,${id}::uuid))
    ORDER BY pinned DESC,touched DESC,visible.id DESC LIMIT 101`
  const rows = (await database.query(statement,[...facts.params,userId,workspaceId,RUN_CHAIN_MAX_DEPTH,input.archived,input.botId ?? null,
    input.search,input.state,input.cursor?.id ?? null,input.cursor?.pinned ?? null,input.cursor?.at ?? null])).rows as Row[]
  const page = rows.slice(0,100), last = page.at(-1)
  return { items: page.map(item).filter(row=>!input.search || row.title.toLowerCase().includes(input.search.toLowerCase())),
    cursor: rows.length>page.length && last ? {id:last.id,at:last.at,pinned:last.pinned} : null }
}

/** A single bounded result per visible Bot, independent of thread-list paging. */
export async function conversationSidebar(database: RunChainQueryable, userId: string, workspaceId: string) {
  const statement = conversationQuery() + `, ranked AS (
    SELECT *,row_number() OVER (PARTITION BY "botId" ORDER BY pinned DESC,
      CASE WHEN state IN ('waiting','failed') THEN 0 WHEN state='working' THEN 1 WHEN status IN ('done','canceled','duplicate') OR "runStatus" IN ('succeeded','failed','stopped','cancelled','canceled') THEN 3 ELSE 2 END,
      touched DESC,id DESC)::integer AS position
    FROM visible WHERE NOT archived AND "botId" IS NOT NULL AND source IS DISTINCT FROM 'mcp'
  ) SELECT * FROM ranked WHERE position<=9 ORDER BY "botId",position`
  const rows = (await database.query(statement,[...facts.params,userId,workspaceId,RUN_CHAIN_MAX_DEPTH])).rows as Row[]
  const bots: Record<string,{ items: (ReturnType<typeof item> & {harness:string | null; status:string | null})[]; more:boolean }> = {}
  for (const row of rows) {
    const group = bots[row.botId!] ??= {items:[],more:false}
    if (row.position===9) group.more=true
    else group.items.push({...item(row),harness:row.harness,status:row.status})
  }
  return bots
}
