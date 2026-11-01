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
type AuthorizedSource = SourceEvent & { issueOwnerId: string | null; scope: string | null; issueContent: Parameters<typeof readIssueMetadata>[0]; knownBotId: string | null; botWorkspace: string | null }
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
        SELECT e.id,e.kind,e.payload,e."issueId",i."userId" AS "issueOwnerId",i.scope,i.content AS "issueContent",
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
      if (events.some(event => event.issueId && (!event.issueOwnerId || readIssueMetadata(event.issueContent).deletedAt))) throw denied()
      const current = pendingTelegramTargets(events)
      if (current.length !== 1 || current[0].threadId !== target.threadId || current[0].telegramUserId !== target.telegramUserId
        || current[0].sourceEventIds.length !== target.sourceEventIds.length) throw denied()
      const foreign = events.filter(event => event.issueId && event.issueOwnerId !== userId)
      if (foreign.some(event => event.scope !== 'workspace')) throw denied()
      const foreignIds = [...new Set(foreign.map(event => event.issueId!))]
      const botWorkspace = events[0].botWorkspace
      if (foreignIds.length || botWorkspace) {
        // Workspace membership lives in a separate database. Read it once,
        // without a nested transaction or locks held across databases.
        const authority = await workspace.connect()
        try {
          const { rows: [access] } = await authority.query<{ allowed: boolean }>(`
            SELECT ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$3 AND "userId"=$1 AND status='active'
            )) AND NOT EXISTS (
              SELECT 1 FROM unnest($2::uuid[]) x(id) WHERE NOT EXISTS (
                SELECT 1 FROM mikka_team_issues t JOIN mikka_workspace_members m ON m."workspaceId"=t."workspaceId"
                WHERE t."issueId"=x.id AND m."userId"=$1 AND m.status='active'
              )
            ) AS allowed`, [userId, foreignIds, botWorkspace])
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
