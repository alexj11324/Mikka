import 'server-only'
import { ActionFailureError } from '@/lib/action-error'
import { botListChanged, botRemovedChanged, groupListChanged } from '@/lib/live/lists'

/**
 * A person archives, restores or deletes one of their own bots (decision 2026-11-17-2040, as Capy's Captain).
 * Archived, a bot keeps its chat and history, leaves the sidebar and takes no new work (dispatch and schedules
 * already skip archived bots). Deleting it removes the bot and what belongs only to it (its chat, attachments,
 * sessions and schedules cascade); the tasks and runs it dispatched stay, without a bot. The Coordinator is
 * neither archived nor deleted; any bot that is not the person's own reads as not found.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Owner = { ownerId: string; workspaceId: string }

// The database loads on first use (as lib/thread-reads.ts does): the actions module that imports this stays light.
const database = () => import('@/lib/db')

export async function setOwnedBotArchived(owner: Owner, botId: string, archived: boolean) {
  if (!UUID.test(botId)) throw new ActionFailureError('botNotFound')
  const { pool } = await database()
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE bots SET "archivedAt"=CASE WHEN $4::boolean THEN COALESCE("archivedAt", now()) ELSE NULL END, "updatedAt"=now()
      WHERE id=$1::uuid AND "ownerId"=$2 AND "workspaceId"=$3::uuid
        AND NOT EXISTS (SELECT 1 FROM coordinator_bots c WHERE c."botId"=bots.id)
      RETURNING id`, [botId, owner.ownerId, owner.workspaceId, archived])
  if (!rows.length) throw new ActionFailureError('botNotFound')
  await botListChanged(pool, botId)
  // An archived Bot's running work stops now; nothing rechecks it later (decision 2026-11-17-2215).
  if (archived) await (await import('@/lib/run-authority-stop')).stopRunsWithoutAuthority({ botId })
  return { id: botId, archived }
}

export async function deleteOwnedBot(owner: Owner, botId: string) {
  if (!UUID.test(botId)) throw new ActionFailureError('botNotFound')
  const { pool, withDatabaseClient } = await database()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const groups = await withDatabaseClient(client, async () => {
      const { rows: [bot] } = await client.query<{ id: string }>(
        `SELECT id FROM bots WHERE id=$1::uuid AND "ownerId"=$2 AND "workspaceId"=$3::uuid
           AND NOT EXISTS (SELECT 1 FROM coordinator_bots c WHERE c."botId"=bots.id) FOR UPDATE`,
        [botId, owner.ownerId, owner.workspaceId])
      if (!bot) return null
      // Links without a cascading key: the bot leaves its group chats, threads it led keep going without it,
      // and a thread machine it used stays with the thread.
      const left = await client.query<{ conversationId: string }>(
        `UPDATE conversation_members SET "leftAt"=now() WHERE "memberType"='bot' AND "memberId"=$1 AND "leftAt" IS NULL RETURNING "conversationId"`, [botId])
      const led = await client.query<{ id: string }>(`UPDATE conversations SET "leadBotId"=NULL WHERE "leadBotId"=$1::uuid RETURNING id`, [botId])
      await client.query(`UPDATE thread_machines SET "botId"=NULL WHERE "botId"=$1::uuid`, [botId])
      await client.query(`DELETE FROM chat_preferences WHERE "userId"=$1 AND "chatKey"=$2`, [owner.ownerId, botId])
      await client.query('DELETE FROM bots WHERE id=$1::uuid', [botId])
      const changed = [...new Set([...left.rows.map(row => row.conversationId), ...led.rows.map(row => row.id)])]
      for (const id of changed) await groupListChanged(client, id)
      await botRemovedChanged(client, owner.ownerId, owner.workspaceId)
      return changed
    })
    if (!groups) {
      await client.query('ROLLBACK')
      throw new ActionFailureError('botNotFound')
    }
    await client.query('COMMIT')
    return { id: botId, deleted: true as const }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** The person's own archived bots in this workspace, newest archive first: the sidebar's 已归档 list. */
export async function ownArchivedBots(owner: Owner) {
  const { pool } = await database()
  const { rows } = await pool.query<{ id: string; name: string; color: string; shape: string }>(
    `SELECT id, name, color, shape FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2::uuid AND "archivedAt" IS NOT NULL
      ORDER BY "archivedAt" DESC, name`, [owner.ownerId, owner.workspaceId])
  return rows
}
