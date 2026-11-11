import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { ownerListChanged } from '@/lib/live/lists'
import { botChatChanged } from '@/lib/live/chats'
import { applyCliFold, applyExternalFold, foldCliRunPolicy, foldExternalWritePermissions } from '@/lib/operations/workspace-policy-fold'

/**
 * The person's Coordinator is an ordinary bot (glossary), one per person per
 * workspace (decision 2026-10-31-2130-personal-vs-workspace): the `bots` row
 * that coordinator_bots names for that workspace. Its chat, memory, inbox,
 * runs, model choice and settings are keyed by that row's id like any bot's.
 *
 * It is resolved only where Coordinator work enters, for the workspace that
 * work belongs to: the web's active workspace, a mobile request's, a
 * channel's own binding (MCP, Slack, Telegram, Linear), or the run, issue,
 * conversation or suggestion it comes from. Work with no workspace of its own
 * uses the personal workspace. The id is stored on the row; later paths (run
 * end, recovery, publication, events) read it and never resolve it again.
 */
export interface CoordinatorBot { botId: string; workspaceId: string }

const RESOLVED_MS = 60_000
/** A row written the old way by an older instance during a deploy is moved by the next pass. */
const BACKFILL_MS = 10 * 60_000
const resolved = new Map<string, { bot: CoordinatorBot; at: number }>()
const backfilled = new Map<string, number>()
const backfillFresh = (ownerId: string) => Date.now() - (backfilled.get(ownerId) ?? -Infinity) < BACKFILL_MS

/** The person's personal workspace, created when they have none yet (as the app does on their first page). */
export async function personalWorkspaceId(ownerId: string): Promise<string> {
  const { pool } = await import('@/lib/db')
  const found = (await pool.query<{ id: string }>(`SELECT w.id FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$1 AND m.status='active'
    WHERE w."userId"=$1 AND w.kind='personal' LIMIT 1`, [ownerId])).rows[0]?.id
  return found ?? createPersonalWorkspace(ownerId)
}

async function createPersonalWorkspace(ownerId: string): Promise<string> {
  const { pool } = await import('@/lib/db')
  const [person] = (await pool.query<{ id: string; email: string; name: string }>('SELECT id,email,name FROM "user" WHERE id=$1', [ownerId])).rows
  if (!person) throw Object.assign(new Error('workspaceAccessDenied'), { code: 'workspaceAccessDenied' })
  return (await import('@/lib/personal-workspace')).ensurePersonalWorkspace(person, 'zh-CN')
}

/**
 * Reuse the explicit-workspace backfill's Personal lookup to observe whether it
 * has work. Only a complete, authorized empty observation skips the existing
 * migration. Late legacy writes remain eligible at the original next pass.
 */
async function personalCoordinatorForBackfill(ownerId: string): Promise<CoordinatorBot | null> {
  const { pool } = await import('@/lib/db')
  const found = (await pool.query<{ id: string; botId: string | null; legacyWork: boolean }>(`SELECT w.id, c."botId",
      (EXISTS (SELECT 1 FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM agent_runs WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM coordinator_events WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM factory_tasks WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=w.id AND "botKey"='coordinator')
        OR EXISTS (SELECT 1 FROM chat_preferences WHERE "userId"=$1 AND "chatKey"='coordinator')
        OR EXISTS (SELECT 1 FROM user_schedules WHERE owner_id=$1 AND bot_id IS NULL)
        OR EXISTS (SELECT 1 FROM suggestions WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM pending_actions WHERE "userId"=$1 AND "botId" IS NULL)
        OR EXISTS (SELECT 1 FROM agent_kit_heads old_head WHERE old_head.owner_id=$1 AND old_head.bot_key='coordinator'
          AND NOT EXISTS (SELECT 1 FROM agent_kit_heads current_head
            WHERE current_head.owner_id=$1 AND current_head.bot_key=c."botId"::text))) AS "legacyWork"
    FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$1 AND m.status='active'
      LEFT JOIN coordinator_bots c ON c."ownerId"=$1 AND c."workspaceId"=w.id
    WHERE w."userId"=$1 AND w.kind='personal' LIMIT 1`, [ownerId])).rows[0]
  if (found?.id && found.botId && found.legacyWork === false) return null
  // A missing authorized Personal row follows the original creation/check path,
  // without issuing the Personal lookup a second time.
  return ensureFor(ownerId, found?.id ?? await createPersonalWorkspace(ownerId))
}

async function ensureFor(ownerId: string, workspaceId: string): Promise<CoordinatorBot> {
  const [{ pool }, { ensureCoordinatorBot }] = await Promise.all([import('@/lib/db'), import('@/lib/computer/auto-runtime')])
  // Only a workspace the person is an active member of gets their Coordinator.
  const member = await pool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\'', [workspaceId, ownerId])
  if (!member.rowCount) throw Object.assign(new Error('workspaceAccessDenied'), { code: 'workspaceAccessDenied' })
  return { botId: await ensureCoordinatorBot(pool, { userId: ownerId, workspaceId }), workspaceId }
}

/**
 * The person's Coordinator in `workspaceId` (their personal workspace when the
 * work has none), created on first use. The first time this process sees the
 * person, their older bot-less chat is moved onto their personal Coordinator.
 * Code inside another transaction passes `backfill: false`: the move takes row
 * locks that transaction may hold, and the next read does it instead.
 */
export async function coordinatorBot(ownerId: string, workspaceId: string | null, options: { backfill?: boolean } = {}): Promise<CoordinatorBot> {
  const where = workspaceId ?? await personalWorkspaceId(ownerId)
  const key = `${ownerId}:${where}`
  const cached = resolved.get(key)
  const bot = cached && Date.now() - cached.at < RESOLVED_MS ? cached.bot : await ensureFor(ownerId, where)
  resolved.set(key, { bot, at: cached?.bot === bot ? cached.at : Date.now() })
  if (options.backfill !== false && !backfillFresh(ownerId)) {
    // Older data has no workspace of its own, so it goes to the personal Coordinator. A move that cannot take its
    // locks now (lock_timeout) is retried on the next read; the chat stays usable meanwhile.
    try {
      const { pool } = await import('@/lib/db')
      const personal = workspaceId ? await personalCoordinatorForBackfill(ownerId) : bot
      if (personal) await backfillCoordinatorChat(pool, ownerId, personal)
      backfilled.set(ownerId, Date.now())
    } catch (error) { console.error('Coordinator chat move deferred', { code: (error as { code?: string }).code }) }
  }
  return bot
}

/** The chat a bot id names: the bot's own, or the person's Coordinator in `workspaceId` when the work has no bot of its own. */
export async function chatBotId(ownerId: string, botId: string | null | undefined, workspaceId: string | null, options: { backfill?: boolean } = {}): Promise<string> {
  return botId ?? (await coordinatorBot(ownerId, workspaceId, options)).botId
}

/**
 * The chat a signed-in request names: its bot, or the Coordinator of the workspace the request has open
 * (a token's own workspace, else the person's active one). For web and mobile entry points.
 */
export async function openChatBotId(user: { id: string; email: string; name: string; image?: string | null }, botId: string | null | undefined): Promise<string> {
  if (botId) return botId
  const { loadWorkspaceContext } = await import('@/lib/workspace-access')
  return chatBotId(user.id, null, (await loadWorkspaceContext(undefined, user)).workspace.id)
}

/**
 * The bot list (web left column, mobile home): the person's bots in this
 * workspace with this workspace's Coordinator first, marked `coordinator`.
 */
export async function listOwnerBots(ownerId: string, workspaceId: string) {
  const [{ db }, { bots }, { and, asc, desc, eq, sql }] = await Promise.all([import('@/lib/db'), import('@/lib/db/schema'), import('drizzle-orm')])
  const { botId } = await coordinatorBot(ownerId, workspaceId)
  const isCoordinator = sql<boolean>`${bots.id} = ${botId}`
  return db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, coordinator: isCoordinator }).from(bots)
    .where(and(eq(bots.ownerId, ownerId), eq(bots.workspaceId, workspaceId)))
    .orderBy(desc(isCoordinator), asc(bots.createdAt))
}

/** Whether this bot is the person's Coordinator (in any workspace). */
export async function isCoordinatorBot(query: Pick<Pool, 'query'>, ownerId: string, botId: string): Promise<boolean> {
  return Boolean((await query.query('SELECT 1 FROM coordinator_bots WHERE "ownerId"=$1 AND "botId"=$2', [ownerId, botId])).rowCount)
}

/** Tests reset what this process remembers between cases. */
export function forgetCoordinatorBots() {
  resolved.clear()
  backfilled.clear()
}

/**
 * Moves the person's Coordinator data still stored the old way (no bot: botId
 * NULL, or the key 'coordinator') onto their Coordinator row: chat messages,
 * session (memory, summary), inbox events, runs, model choice, chat settings,
 * schedules, factory tasks, suggestions, cards and the agent definition's head.
 * A frozen execution identity (including an invalid snapshot) and its Factory
 * family retain their original null-Bot scope, even after the run has ended. One transaction
 * per person under an advisory lock, so it is safe to run twice and while
 * the chat is in use: rows already moved are not touched again, and a late
 * row written the old way (an older instance during a rolling deploy) is
 * appended after what the row already holds.
 */
export async function backfillCoordinatorChat(pool: Pick<Pool, 'connect'>, ownerId: string, bot: CoordinatorBot): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`coordinator-backfill:${ownerId}`])
    // The same locks a turn takes to number its messages (lib/coordinator/store.ts nextPosition).
    for (const key of [`bot-chat:${ownerId}:coordinator`, `bot-chat:${ownerId}:${bot.botId}`]) {
      const { rows: [lock] } = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])
      if (!lock.acquired) throw Object.assign(new Error('coordinatorBackfillBusy'), { code: '55P03' })
    }
    const owned = await client.query('SELECT 1 FROM coordinator_bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botId"=$3', [ownerId, bot.workspaceId, bot.botId])
    if (!owned.rowCount) throw new Error('coordinatorBotMissing')
    const movedRuns = await moveExecutionRows(client, ownerId, bot.botId, bot.workspaceId)
    await moveChat(client, ownerId, bot.botId)
    await moveKeyedRows(client, ownerId, bot)
    if (movedRuns) await ownerListChanged(client, ownerId, ['thread_list', 'task_run_list'])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function moveChat(client: PoolClient, ownerId: string, botId: string) {
  // appendMessages locks its session before taking the chat advisory lock.
  // If it already owns that row, release our chat lock by deferring this pass.
  await client.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND ("botId" IS NULL OR "botId"=$2) FOR UPDATE NOWAIT', [ownerId, botId])
  const target = (await client.query<{ last: number }>('SELECT coalesce(max(position),0)::int AS last FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [ownerId, botId])).rows[0].last
  // Positions stay as they were when the row holds no messages yet, so the session's summaryThrough still points at the same message.
  const messages = await client.query(`UPDATE coordinator_messages m SET "botId"=$2, position=$3 + n.rank
    FROM (SELECT id, CASE WHEN $3=0 THEN position ELSE row_number() OVER (ORDER BY position) END AS rank
      FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NULL) n
    WHERE m.id=n.id`, [ownerId, botId, target])
  const old = (await client.query('SELECT * FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NULL', [ownerId])).rows[0]
  if (old?.summary) old.summary = await movedSummary(ownerId, botId, old.summary)
  if (old) {
    const current = (await client.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [ownerId, botId])).rows[0]
    if (!current) await client.query('UPDATE coordinator_sessions SET "botId"=$2, summary=$3 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId, old.summary])
    else {
      // The row's own session wins; an older chat's summary and memory carry over only where the row has none.
      await client.query(`UPDATE coordinator_sessions SET
          memory=CASE WHEN memory='' THEN $3 ELSE memory END,
          summary=CASE WHEN $4 AND summary IS NULL THEN $5 ELSE summary END,
          "summaryThrough"=CASE WHEN $4 AND summary IS NULL THEN $6 ELSE "summaryThrough" END,
          "updatedAt"=now()
        WHERE "userId"=$1 AND "botId"=$2`, [ownerId, botId, old.memory, target === 0, old.summary, old.summaryThrough])
      await client.query('DELETE FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NULL', [ownerId])
    }
  }
  if (messages.rowCount || old) await botChatChanged(client, ownerId, botId)
}

/**
 * A run's frozen identity is execution authority, not a display/chat key. Keep
 * its tasks, sibling attempts and source/terminal events in that same domain.
 * A source may start several tasks, so retention follows those shared links.
 * Runs owned by a different computer/group or barred by issue retirement must
 * seed that retention too; merely excluding their UPDATE would split the family.
 * Work in another workspace or still awaiting attribution also seeds retention.
 * Moving a personal chat never assigns a workspace or reattributes its tasks.
 *
 * Publication/completion lock issue -> run, and the run's scope trigger takes
 * an issue SHARE lock even when only botId changes. Take that lock first.
 * Factory writes lock task -> issue -> source (sourceAllowed); repository
 * admission locks its request event. Every subsequent lock is NOWAIT too.
 * Never wait in the opposite direction: NOWAIT rolls this whole best-effort
 * migration back before it can obstruct an in-flight admission. Only the ids
 * locked here are moved. A row committed between these lock statements is a
 * retained seed, including its family, until the next pass. The final statement
 * reads the newly committed family and updates all three tables in one snapshot.
 */
async function moveExecutionRows(client: PoolClient, ownerId: string, botId: string, workspaceId: string): Promise<number> {
  const issues = (await client.query<{ id: string }>(`SELECT i.id FROM issues i WHERE EXISTS (
    SELECT 1 FROM agent_runs r WHERE r."userId"=$1 AND r."botId" IS NULL AND r."issueId"=i.id
  ) ORDER BY i.id FOR SHARE OF i NOWAIT`, [ownerId])).rows.map(row => row.id)
  const tasks = (await client.query<{ id: string }>('SELECT id FROM factory_tasks WHERE "userId"=$1 AND "botId" IS NULL ORDER BY id FOR UPDATE NOWAIT', [ownerId])).rows.map(row => row.id)
  const events = (await client.query<{ id: string }>('SELECT id FROM coordinator_events WHERE "userId"=$1 AND "botId" IS NULL ORDER BY id FOR UPDATE NOWAIT', [ownerId])).rows.map(row => row.id)
  const runs = (await client.query<{ id: string }>('SELECT id FROM agent_runs WHERE "userId"=$1 AND "botId" IS NULL ORDER BY id FOR UPDATE NOWAIT', [ownerId])).rows.map(row => row.id)
  // Every write below is restricted to these captured ids; late rows are excluded too.
  if (!tasks.length && !events.length && !runs.length) return 0
  const moved = await client.query(`WITH RECURSIVE
    own_tasks AS MATERIALIZED (SELECT id,"sourceEventId","workspaceId" FROM factory_tasks WHERE "userId"=$1 AND "botId" IS NULL),
    own_runs AS MATERIALIZED (SELECT id,"botId","agentDefinition","issueId","workspaceId",kind FROM agent_runs WHERE "userId"=$1),
    own_events AS MATERIALIZED (SELECT id,"botId","runId","issueId",payload FROM coordinator_events WHERE "userId"=$1),
    task_sources AS (
      SELECT id AS "taskId","sourceEventId"::text AS "eventId" FROM own_tasks
      UNION ALL
      SELECT a."taskId",v.id FROM factory_attempts a JOIN own_tasks t ON t.id=a."taskId"
        CROSS JOIN LATERAL (VALUES (a.output->>'requestEpoch'),(a.output->>'previousRequestEpoch'),(a.output#>>'{handoff,requestEpoch}')) v(id)
      UNION ALL
      SELECT f."taskId",v.id FROM factory_events f JOIN own_tasks t ON t.id=f."taskId"
        CROSS JOIN LATERAL (VALUES (f.request->>'sourceEventId'),(f.request->>'previousEpoch'),(f.result#>>'{task,sourceEventId}')) v(id)
    ), links(kind,id,other_kind,other_id) AS (
      SELECT 'task',a."taskId"::text,'run',r.id::text FROM factory_attempts a
        JOIN own_tasks t ON t.id=a."taskId" JOIN own_runs r ON r.id=a."runId"
      UNION ALL
      SELECT 'task',s."taskId"::text,'event',e.id::text FROM task_sources s JOIN own_events e ON e.id::text=s."eventId"
      UNION ALL
      SELECT 'run',r.id::text,'event',e.id::text FROM own_runs r JOIN own_events e ON e."runId"=r.id
      UNION ALL
      SELECT 'run',r.id::text,'event',e.id::text FROM own_runs r JOIN own_events e ON e.payload->>'previousRunId'=r.id::text
      UNION ALL
      SELECT 'run',r.id::text,'event',e.id::text FROM own_runs r JOIN own_events e ON e.id::text=r."agentDefinition"#>>'{repositoryAdmission,requestEventId}'
      UNION ALL
      SELECT 'event',e.id::text,'event',origin.id::text FROM own_events e JOIN own_events origin ON origin.id::text=e.payload->>'originEventId'
    ), edges AS (SELECT * FROM links UNION ALL SELECT other_kind,other_id,kind,id FROM links),
    seeds(kind,id) AS (
      SELECT 'run',r.id::text FROM own_runs r WHERE r."agentDefinition" ? 'executionIdentity'
        OR r.kind='group_chat'
        OR r."workspaceId" IS DISTINCT FROM $7::uuid
        OR (r."issueId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.id=r."issueId" AND i."workspaceId"=$7))
        OR EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."botId"<>$2)
        OR EXISTS (SELECT 1 FROM issues i WHERE i.id=r."issueId" AND i.scope='personal' AND i."userId"<>$1)
        OR (r."botId" IS NULL AND (NOT r.id=ANY($5::uuid[]) OR (r."issueId" IS NOT NULL AND NOT r."issueId"=ANY($6::uuid[]))))
      UNION ALL
      SELECT 'event',e.id::text FROM own_events e WHERE (e."botId" IS NULL AND NOT e.id=ANY($4::uuid[]))
        OR (e."issueId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.id=e."issueId" AND i."workspaceId"=$7))
        OR (e."runId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=e."runId" AND r."workspaceId"=$7))
        OR EXISTS (SELECT 1 FROM factory_tasks t WHERE t."sourceEventId"=e.id AND t."workspaceId" IS DISTINCT FROM $7::uuid)
      UNION ALL
      SELECT 'task',id::text FROM own_tasks WHERE "workspaceId" IS DISTINCT FROM $7::uuid
        OR NOT (id=ANY($3::uuid[]) AND "sourceEventId"=ANY($4::uuid[]))
    ), retained(kind,id) AS (
      SELECT kind,id FROM seeds
      UNION
      SELECT e.other_kind,e.other_id FROM retained r JOIN edges e ON e.kind=r.kind AND e.id=r.id
    ), moved_events AS (
      UPDATE coordinator_events e SET "botId"=$2 WHERE e."userId"=$1 AND e."botId" IS NULL AND e.id=ANY($4::uuid[])
        AND NOT EXISTS (SELECT 1 FROM retained p WHERE p.kind='event' AND p.id=e.id::text) RETURNING e.id
    ), moved_tasks AS (
      UPDATE factory_tasks t SET "botId"=$2 WHERE t."userId"=$1 AND t."botId" IS NULL AND t.id=ANY($3::uuid[])
        AND NOT EXISTS (SELECT 1 FROM retained p WHERE p.kind='task' AND p.id=t.id::text) RETURNING t.id
    )
    UPDATE agent_runs r SET "botId"=$2 WHERE r."userId"=$1 AND r."botId" IS NULL AND r.id=ANY($5::uuid[])
      AND r.kind <> 'group_chat'
      AND NOT EXISTS (SELECT 1 FROM retained p WHERE p.kind='run' AND p.id=r.id::text)
      AND NOT EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."botId"<>$2)`, [ownerId, botId, tasks, events, runs, issues, workspaceId])
  return moved.rowCount ?? 0
}

/**
 * A compacted summary is signed for its chat ([userId, botId], workflows/coordinator/steps.ts
 * preparePrompt), so the moved one is signed again for the Coordinator's bot row; otherwise
 * the next turn would drop it as unverified. One that does not verify stays as it was.
 */
async function movedSummary(ownerId: string, botId: string, summary: string): Promise<string> {
  const key = process.env.BETTER_AUTH_SECRET ?? ''
  if (key.length < 32) return summary
  const { rescopeSummary } = await import('./message-safety')
  return rescopeSummary(summary, { key, scope: JSON.stringify([ownerId, null]) }, { key, scope: JSON.stringify([ownerId, botId]) }) ?? summary
}

async function moveKeyedRows(client: PoolClient, ownerId: string, { botId, workspaceId }: CoordinatorBot) {
  await client.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId","apiKeyId","apiKeyModel")
      SELECT "ownerId","workspaceId",$3,"bindingId","apiKeyId","apiKeyModel" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"='coordinator'
      ON CONFLICT ("ownerId","workspaceId","botKey") DO NOTHING`, [ownerId, workspaceId, botId])
  await client.query(`DELETE FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"='coordinator'`, [ownerId, workspaceId])
  await client.query(`INSERT INTO chat_preferences ("userId","chatKey",pinned,muted,"updatedAt")
      SELECT "userId",$2,pinned,muted,"updatedAt" FROM chat_preferences WHERE "userId"=$1 AND "chatKey"='coordinator'
      ON CONFLICT ("userId","chatKey") DO NOTHING`, [ownerId, botId])
  await client.query(`DELETE FROM chat_preferences WHERE "userId"=$1 AND "chatKey"='coordinator'`, [ownerId])
  await client.query(`UPDATE user_schedules s SET bot_id=$2, workspace_id=$3 WHERE s.owner_id=$1 AND s.bot_id IS NULL
      AND (s.workspace_id=$3 OR (s.workspace_id IS NULL AND EXISTS (
        SELECT 1 FROM coordinator_events e WHERE e.id=s.source_event_id AND e."userId"=$1 AND e."botId"=$2)))
      AND NOT EXISTS (SELECT 1 FROM user_schedules o WHERE o.owner_id=$1 AND o.bot_id=$2 AND o.request_id=s.request_id)`, [ownerId, botId, workspaceId])
  await client.query('UPDATE suggestions SET "botId"=$2 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId])
  await client.query('UPDATE pending_actions SET "botId"=$2 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId])
  await copyAgentHead(client, ownerId, botId, workspaceId)
}

/**
 * The Coordinator's agent definition is kept on the account's 'coordinator'
 * head; versions are immutable history, so the active definition is copied as
 * the new row's first version. The two policy columns are not copied: a Bot has
 * no permission layer. The legacy head's deny/ask choices are folded into the
 * workspace policy first, so no restriction is lost.
 */
async function copyAgentHead(client: PoolClient, ownerId: string, botId: string, workspaceId: string) {
  const old = (await client.query(`SELECT h.cli_run_policy, h.external_write_permissions,
      v.definition, v.digest, v.source
    FROM agent_kit_heads h LEFT JOIN agent_kit_versions v ON v.owner_id=h.owner_id AND v.bot_key=h.bot_key AND v.id=h.active_version
    WHERE h.owner_id=$1 AND h.bot_key='coordinator'`, [ownerId])).rows[0]
  if (!old) return
  const created = await client.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,bot_key) DO NOTHING`, [ownerId, botId, botId, workspaceId])
  // Fold only when this head is first created. A later backfill must not
  // re-apply the legacy ceiling over an admin's newer workspace choice.
  if (!created.rowCount) return
  // The same locks the workspace policy writers take, before the row read.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-external-write:${workspaceId}`])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${workspaceId}`])
  const policy = (await client.query<{ external_write_permissions: unknown; cli_run_policy: unknown }>(
    'SELECT external_write_permissions,cli_run_policy FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR UPDATE', [workspaceId])).rows[0]
  const external = applyExternalFold(policy?.external_write_permissions, foldExternalWritePermissions([old.external_write_permissions, policy?.external_write_permissions]))
  const cli = applyCliFold(policy?.cli_run_policy, foldCliRunPolicy([old.cli_run_policy, policy?.cli_run_policy]))
  await client.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,external_write_permissions,external_write_policy_version,cli_run_policy)
      VALUES ($1,'allow',$2,case when $2::jsonb='{}'::jsonb then 0 else 1 end,$3)
      ON CONFLICT ("workspaceId") DO UPDATE SET external_write_permissions=excluded.external_write_permissions,cli_run_policy=excluded.cli_run_policy
      WHERE workspace_computer_policies.external_write_permissions IS DISTINCT FROM excluded.external_write_permissions
         OR workspace_computer_policies.cli_run_policy IS DISTINCT FROM excluded.cli_run_policy`, [workspaceId, external, cli])
  if (!old.definition) return
  const versionId = crypto.randomUUID()
  await client.query(`INSERT INTO agent_kit_versions (id,owner_id,bot_key,version,definition,digest,source,request_key,base_version)
      VALUES ($1,$2,$3,1,$4,$5,$6,'coordinator-bot-backfill',NULL)`, [versionId, ownerId, botId, old.definition, old.digest, old.source])
  await client.query('UPDATE agent_kit_heads SET active_version=$3, next_version=2 WHERE owner_id=$1 AND bot_key=$2', [ownerId, botId, versionId])
}
