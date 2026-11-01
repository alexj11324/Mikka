import 'server-only'
import type { Pool, PoolClient } from 'pg'

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
  if (found) return found
  const [person] = (await pool.query<{ id: string; email: string; name: string }>('SELECT id,email,name FROM "user" WHERE id=$1', [ownerId])).rows
  if (!person) throw Object.assign(new Error('workspaceAccessDenied'), { code: 'workspaceAccessDenied' })
  return (await import('@/lib/personal-workspace')).ensurePersonalWorkspace(person, 'zh-CN')
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
      const personal = workspaceId ? await ensureFor(ownerId, await personalWorkspaceId(ownerId)) : bot
      await backfillCoordinatorChat(pool, ownerId, personal)
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
 * schedules, factory tasks, suggestions, cards and the agent definition's head. One transaction
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
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-chat:${ownerId}:coordinator`])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-chat:${ownerId}:${bot.botId}`])
    const owned = await client.query('SELECT 1 FROM coordinator_bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botId"=$3', [ownerId, bot.workspaceId, bot.botId])
    if (!owned.rowCount) throw new Error('coordinatorBotMissing')
    await moveChat(client, ownerId, bot.botId)
    await moveKeyedRows(client, ownerId, bot)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function moveChat(client: PoolClient, ownerId: string, botId: string) {
  await client.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND ("botId" IS NULL OR "botId"=$2) FOR UPDATE', [ownerId, botId])
  const target = (await client.query<{ last: number }>('SELECT coalesce(max(position),0)::int AS last FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [ownerId, botId])).rows[0].last
  // Positions stay as they were when the row holds no messages yet, so the session's summaryThrough still points at the same message.
  await client.query(`UPDATE coordinator_messages m SET "botId"=$2, position=$3 + n.rank
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
  await client.query('UPDATE coordinator_events SET "botId"=$2 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId])
  // The Coordinator's threads: every run of the person's with no bot (an MCP client's too), except a group chat's own.
  await client.query(`UPDATE agent_runs r SET "botId"=$2 WHERE r."userId"=$1 AND r."botId" IS NULL
      AND r.kind <> 'group_chat'
      AND NOT EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."botId"<>$2)`, [ownerId, botId])
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
      AND NOT EXISTS (SELECT 1 FROM user_schedules o WHERE o.owner_id=$1 AND o.bot_id=$2 AND o.request_id=s.request_id)`, [ownerId, botId, workspaceId])
  await client.query('UPDATE factory_tasks SET "botId"=$2 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId])
  await client.query('UPDATE suggestions SET "botId"=$2 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId])
  await client.query('UPDATE pending_actions SET "botId"=$2 WHERE "userId"=$1 AND "botId" IS NULL', [ownerId, botId])
  await copyAgentHead(client, ownerId, botId, workspaceId)
}

/**
 * The Coordinator's agent definition and its two run policies (computer use,
 * external writes) were kept on the account's 'coordinator' head. Versions are
 * immutable history, so the active definition is copied as the row's first
 * version and the policies with it (Plugins › GitHub's two writes among
 * them, lib/github/plugin-permissions.ts); the old head stays as history.
 */
async function copyAgentHead(client: PoolClient, ownerId: string, botId: string, workspaceId: string) {
  const old = (await client.query(`SELECT h.cli_run_policy, h.cli_run_policy_version, h.external_write_permissions, h.external_write_policy_version,
      v.definition, v.digest, v.source
    FROM agent_kit_heads h LEFT JOIN agent_kit_versions v ON v.owner_id=h.owner_id AND v.bot_key=h.bot_key AND v.id=h.active_version
    WHERE h.owner_id=$1 AND h.bot_key='coordinator'`, [ownerId])).rows[0]
  if (!old) return
  const created = await client.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id,cli_run_policy,cli_run_policy_version,external_write_permissions,external_write_policy_version)
      VALUES ($1,$2,$8,$3,$4,$5,$6,$7) ON CONFLICT (owner_id,bot_key) DO NOTHING`,
  [ownerId, botId, workspaceId, old.cli_run_policy, old.cli_run_policy_version, old.external_write_permissions, old.external_write_policy_version, botId])
  if (!created.rowCount || !old.definition) return
  const versionId = crypto.randomUUID()
  await client.query(`INSERT INTO agent_kit_versions (id,owner_id,bot_key,version,definition,digest,source,request_key,base_version)
      VALUES ($1,$2,$3,1,$4,$5,$6,'coordinator-bot-backfill',NULL)`, [versionId, ownerId, botId, old.definition, old.digest, old.source])
  await client.query('UPDATE agent_kit_heads SET active_version=$3, next_version=2 WHERE owner_id=$1 AND bot_key=$2', [ownerId, botId, versionId])
}
