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
type AuthorizedSource = SourceEvent & { issueOwnerId: string | null; issueWorkspace: string | null; ownershipState: string | null; issueContent: Parameters<typeof readIssueMetadata>[0]; knownBotId: string | null; botWorkspace: string | null }
const denied = () => new Error('telegramReplySourceUnavailable')

/** Public reply custody only. Reuses current owner/task/workspace access and
 * the existing APP transaction; no organization policy, quota or audit module. */
export function createTelegramReplies(app: Pick<Pool, 'connect'>, workspace: Pick<Pool, 'connect'>) {
  async function guarded<T>(userId: string, botId: string, holder: string, raw: PendingTelegramTarget, work: (tx: PoolClient, target: PendingTelegramTarget) => Promise<T>): Promise<T> {
    const target = receipt.parse(raw)
    target.sourceEventIds = [...new Set(target.sourceEventIds)].sort()
    return writeTransaction(app, async tx => {
      await tx.query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','10s',true)")
      // One app authorization read binds the live lease, Telegram link, Bot,
      // source events and their current issue owners. No lock choreography.
      const { rows: events } = await tx.query<AuthorizedSource>(`
        SELECT e.id,e.kind,e.payload,e."issueId",i."userId" AS "issueOwnerId",i."workspaceId" AS "issueWorkspace",i."ownershipState",i.content AS "issueContent",
          b.id AS "knownBotId",b."workspaceId" AS "botWorkspace"
        FROM coordinator_events e LEFT JOIN issues i ON i.id=e."issueId"
        LEFT JOIN bots b ON b.id=$3::uuid AND b."ownerId"=$2
        WHERE e.id=ANY($1::uuid[]) AND e."userId"=$2 AND e."botId"=$3::uuid
          AND e."deliveredAt" IS NOT NULL
          AND EXISTS (SELECT 1 FROM coordinator_sessions s WHERE s."userId"=$2 AND s."botId"=$3::uuid
            AND s."leaseHolder"=$4 AND s."leaseUntil">clock_timestamp())
          AND EXISTS (SELECT 1 FROM telegram_links l WHERE l."userId"=$2 AND l."telegramUserId"=$5)
        ORDER BY e.id`, [target.sourceEventIds, userId, botId, holder, target.telegramUserId])
      if (events.length !== target.sourceEventIds.length || events[0].knownBotId !== botId) throw denied()
      const botWorkspace = events[0].botWorkspace
      if (!botWorkspace || events.some(event => event.issueId && (!event.issueOwnerId || event.ownershipState !== 'bound'
        || event.issueWorkspace !== botWorkspace || readIssueMetadata(event.issueContent).deletedAt))) throw denied()
      const current = pendingTelegramTargets(events)
      if (current.length !== 1 || current[0].threadId !== target.threadId || current[0].telegramUserId !== target.telegramUserId
        || current[0].sourceEventIds.length !== target.sourceEventIds.length) throw denied()
      {
        // Workspace membership lives in a separate database. Read it once,
        // without a nested transaction or locks held across databases.
        const authority = await workspace.connect()
        try {
          const { rows: [access] } = await authority.query<{ allowed: boolean }>(`
            SELECT EXISTS (
              SELECT 1 FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id=m."workspaceId"
              WHERE w.id=$2::uuid AND m."userId"=$1 AND m.status='active'
                AND (w.kind='team' OR (w.kind='personal' AND w."userId"=$1))
            ) AS allowed`, [userId, botWorkspace])
          if (!access?.allowed) throw denied()
        } finally { authority.release() }
      }
      return work(tx, target)
    })
  }
  return {
    async send(userId: string, botId: string, holder: string, target: PendingTelegramTarget, send: (tx: PoolClient) => Promise<void>) {
      await guarded(userId, botId, holder, target, send)
    },
    async acknowledge(userId: string, botId: string, holder: string, target: PendingTelegramTarget) {
      await guarded(userId, botId, holder, target, async (tx, bound) => {
        // Exact source IDs form the watermark: a new event, even for the same
        // Telegram destination, cannot be acknowledged by an older turn.
        await tx.query(`UPDATE coordinator_events SET payload=jsonb_set(payload,'{mikkaTelegramReply}','{"version":1,"state":"sent"}'::jsonb) WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid`, [bound.sourceEventIds, userId, botId])
      })
    },
  }
}
