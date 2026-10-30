import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { writeTransaction } from '../operations/write-transaction'
import { readIssueMetadata } from '../issue-metadata'
import { pendingTelegramTargets, type PendingTelegramTarget, type TelegramPendingEvent } from './telegram-pending'

const receipt = z.object({
  threadId: z.string().min(1).max(512),
  telegramUserId: z.string().min(1).max(128),
  sourceEventIds: z.array(z.uuid()).min(1).max(100),
}).strict()
type SourceEvent = TelegramPendingEvent & { issueId: string | null }
type SourceIssue = { id: string; userId: string; scope: string; content: Parameters<typeof readIssueMetadata>[0] }
const denied = () => new Error('telegramReplySourceUnavailable')

/** Public reply custody only. Reuses current owner/task/workspace access and
 * the existing APP transaction; no organization policy, quota or audit module. */
export function createTelegramReplies(app: Pick<Pool, 'connect'>, workspace: Pick<Pool, 'connect'>) {
  async function guarded<T>(userId: string, botId: string | null, holder: string, raw: PendingTelegramTarget, work: (tx: PoolClient, target: PendingTelegramTarget) => Promise<T>): Promise<T> {
    const target = receipt.parse(raw)
    target.sourceEventIds = [...new Set(target.sourceEventIds)].sort()
    return writeTransaction(app, async tx => {
      await tx.query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)")
      let botWorkspace: string | undefined
      if (botId) {
        const bot = await tx.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 FOR SHARE', [botId, userId])
        if (!bot.rows[0]) throw denied()
        botWorkspace = bot.rows[0].workspaceId
      }
      if (!(await tx.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid AND "leaseHolder"=$3 FOR SHARE', [userId, botId, holder])).rowCount) throw denied()
      const query = 'SELECT id,kind,payload,"issueId" FROM coordinator_events WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid AND "deliveredAt" IS NOT NULL ORDER BY id'
      const hints = (await tx.query<SourceEvent>(query, [target.sourceEventIds, userId, botId])).rows
      if (hints.length !== target.sourceEventIds.length) throw denied()
      const issueIds = [...new Set(hints.flatMap(event => event.issueId ? [event.issueId] : []))].sort()
      // Unlocked read: only decides which workspace membership rows to lock.
      // Lock order matches team-issue-create: workspace members first, then
      // issue parents, then their event children (deletion cascades take the
      // issue -> event order). Everything is re-validated after the locks.
      const seen = issueIds.length
        ? (await tx.query<SourceIssue>('SELECT id,"userId",scope,content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [issueIds])).rows
        : []
      if (seen.length !== issueIds.length) throw denied()
      const foreignIds = seen.filter(issue => issue.userId !== userId).map(issue => issue.id).sort()
      const lockSources = async () => {
        const sourceIssues = issueIds.length
          ? (await tx.query<SourceIssue>('SELECT id,"userId",scope,content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [issueIds])).rows
          : []
        if (sourceIssues.length !== issueIds.length || sourceIssues.some(issue => readIssueMetadata(issue.content).deletedAt)) throw denied()
        const events = (await tx.query<SourceEvent>(query + ' FOR SHARE', [target.sourceEventIds, userId, botId])).rows
        if (events.some(event => hints.find(hint => hint.id === event.id)?.issueId !== event.issueId)) throw denied()
        const current = pendingTelegramTargets(events)
        if (current.length !== 1 || current[0].threadId !== target.threadId || current[0].telegramUserId !== target.telegramUserId
          || current[0].sourceEventIds.length !== target.sourceEventIds.length) throw denied()
        if (!(await tx.query('SELECT 1 FROM telegram_links WHERE "userId"=$1 AND "telegramUserId"=$2 FOR SHARE', [userId, target.telegramUserId])).rowCount) throw denied()
        const foreign = sourceIssues.filter(issue => issue.userId !== userId)
        // An owner change between the unlocked read and the lock would skip a membership check.
        if (foreign.map(issue => issue.id).sort().join() !== foreignIds.join()) throw denied()
        if (foreign.some(issue => issue.scope !== 'workspace')) throw denied()
      }
      const invoke = async () => {
        // Fresh statement after every lock wait, including membership waits.
        if (!(await tx.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid AND "leaseHolder"=$3 AND "leaseUntil">clock_timestamp()', [userId, botId, holder])).rowCount) throw denied()
        return work(tx, target)
      }
      if (!foreignIds.length && !botWorkspace) {
        await lockSources()
        return invoke()
      }
      return writeTransaction(workspace, async authority => {
        await authority.query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)")
        if (botWorkspace && !(await authority.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\' FOR SHARE', [botWorkspace, userId])).rowCount) throw denied()
        if (foreignIds.length) {
          const links = await authority.query<{ issueId: string }>('SELECT t."issueId" FROM mikka_team_issues t JOIN mikka_workspace_members m ON m."workspaceId"=t."workspaceId" AND m."userId"=$2 AND m.status=\'active\' WHERE t."issueId"=ANY($1::uuid[]) ORDER BY t."issueId" FOR SHARE OF t,m', [foreignIds, userId])
          if (new Set(links.rows.map(link => link.issueId)).size !== foreignIds.length) throw denied()
        }
        // Issue parents only after membership, never the reverse (BE-14).
        await lockSources()
        return invoke()
      })
    })
  }
  return {
    async send(userId: string, botId: string | null, holder: string, target: PendingTelegramTarget, send: (tx: PoolClient) => Promise<void>) {
      await guarded(userId, botId, holder, target, send)
    },
    async acknowledge(userId: string, botId: string | null, holder: string, target: PendingTelegramTarget) {
      await guarded(userId, botId, holder, target, async (tx, bound) => {
        // Exact source IDs form the watermark: a new event, even for the same
        // Telegram destination, cannot be acknowledged by an older turn.
        await tx.query(`UPDATE coordinator_events SET payload=jsonb_set(payload,'{mikkaTelegramReply}','{"version":1,"state":"sent"}'::jsonb) WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid`, [bound.sourceEventIds, userId, botId])
      })
    },
  }
}
