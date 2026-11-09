import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { agentRuns, bots } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { readPreferences } from '@/lib/preferences'
import { pushAllowed } from '@/lib/push-allowed'
import type { PushReason } from '@/lib/push-reasons'
import { chatMuted } from '@/lib/chat-preferences'
import { openUIText, parseOpenUI } from '@/lib/openui-lang'
import type { ActionLocale } from '@/lib/suggestions/action-title'
import { personLocale } from '@/lib/suggestions/action-title-server'
import { appOrigin } from '@/lib/mcp/resource'
import { BASE_PATH } from '@/lib/base-path'

import { deliverPhonePush } from '@/lib/mobile-push-delivery'
import { CloudServiceError } from '@/lib/cloud-services/errors'
const BODY_MAX = 180
const MESSAGES = {
  'zh-CN': () => import('@/messages/zh-CN.json'),
  en: () => import('@/messages/en.json'),
} as const

/**
 * The push for a verification code, in the person's language: it only says
 * one came; the code stays in the app chat. Read straight from the messages:
 * next-intl's entry loads React hooks, which the react-server condition
 * (workflow steps, tests) does not have.
 */
export async function codePushBody(locale: ActionLocale): Promise<string> {
  return (await MESSAGES[locale]()).default.MobilePush.verificationCode
}

export { pushAllowed }

/**
 * The push text: the reply's first lines, without citation tokens or Markdown
 * marks. A card (OpenUI) is read as its words: its text, question and options.
 * Pushes have no buttons (mobile.md).
 */
export function pushBody(text: string): string {
  const card = parseOpenUI(text)
  const plain = (card === null ? text : openUIText(card))
    .replace(/\[\[(?:issue|run|artifact):[0-9a-f-]{36}\]\]/gi, '')
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > BODY_MAX ? `${plain.slice(0, BODY_MAX - 1)}…` : plain
}

/**
 * Sends a Coordinator (or bot) reply to every phone the person signed in on,
 * when their settings allow it and the chat's 通知 is on. A verified task target includes its
 * Workspace; without one, tapping opens the chat. `text` null
 * is a reply about a verification code: the push only says one came, the code
 * stays in the app chat. Tokens Expo reports as gone are removed. Never throws.
 */
export async function pushReply(userId: string, botId: string, text: string | null, reasons: readonly PushReason[], task: { issueId: string; runId: string | null } | null = null): Promise<void> {
  try {
    if (!reasons.length || text?.trim() === '') return
    const [origin] = await db.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, userId), isNull(bots.archivedAt))).limit(1)
    if (!origin) return
    let deliveryFailure: CloudServiceError | undefined
    // Workspace/member precede APP locks. The session and destination remain
    // pinned until the bounded send and its accepted receipts are committed.
    await withTaskWorkspace(userId, origin.workspaceId, async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await withDatabaseClient(client, async () => {
            if (!pushAllowed(await readPreferences(userId), reasons)) return
            if (await chatMuted(userId, botId)) return
            const [bot] = await db.select({ name: bots.name, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` }).from(bots)
              .where(and(eq(bots.id, botId), eq(bots.ownerId, userId), eq(bots.workspaceId, origin.workspaceId), isNull(bots.archivedAt))).limit(1).for('share')
            if (!bot) return
            const candidates = await client.query<{ sessionId: string }>(
              'SELECT DISTINCT "sessionId" FROM mobile_push_tokens WHERE "userId"=$1 AND "sessionId" IS NOT NULL ORDER BY "sessionId"', [userId])
            const sessionIds: string[] = []
            for (const { sessionId } of candidates.rows) {
              const session = await client.query(
                'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE', [sessionId, userId])
              if (session.rowCount) sessionIds.push(sessionId)
            }
            if (!sessionIds.length) return
            // UPDATE also serializes provider-driven invalid-token deletion;
            // two SHARE holders must never both upgrade their token lock.
            const destinations = await client.query<{ token: string; sessionId: string }>(
              'SELECT token,"sessionId" FROM mobile_push_tokens WHERE "userId"=$1 AND "sessionId"=ANY($2::text[]) ORDER BY id FOR UPDATE', [userId, sessionIds])
            if (!destinations.rows.length) return
            const locale = await personLocale(userId)
            const body = text === null ? await codePushBody(locale) : pushBody(text)
            if (task) {
              // Historical event ids are routing hints, not current authority.
              // Both helpers reuse this operation's held WS and APP clients.
              const reader = { id: userId, [tokenWorkspace]: origin.workspaceId }
              const issue = await issueForUser(reader, task.issueId, false, db, { withoutBody: true })
              if (!issue || issue.workspaceId !== origin.workspaceId) return
              if (task.runId) {
                const [run] = await db.select({ id: agentRuns.id }).from(agentRuns)
                  .where(and(eq(agentRuns.id, task.runId), eq(agentRuns.userId, userId),
                    eq(agentRuns.issueId, issue.id), eq(agentRuns.workspaceId, origin.workspaceId))).limit(1)
                if (!run) return
              }
            }
            // Lock waits, target and locale reads must not extend a session's expiry.
            const fresh = await client.query<{ id: string }>(
              'SELECT id FROM "session" WHERE "userId"=$1 AND id=ANY($2::text[]) AND "expiresAt">clock_timestamp()', [userId, sessionIds])
            const active = new Set(fresh.rows.map(row => row.id))
            const tokens = destinations.rows.filter(row => active.has(row.sessionId)).map(row => row.token)
            if (!tokens.length) return
            try {
              await deliverPhonePush(userId, { to: tokens, title: bot.coordinator ? 'Coordinator' : bot.name, body,
                data: { botId: bot.coordinator ? null : botId, serverUrl: appOrigin + BASE_PATH, userId,
                  ...(task ? { workspaceId: origin.workspaceId, issueId: task.issueId, ...(task.runId ? { runId: task.runId } : {}) } : {}) }, collapseId: botId }, locale)
            } catch (error) {
              if (!(error instanceof CloudServiceError)) throw error
              // Partial provider rejection follows accepted receipt inserts.
              // Commit those receipts before reporting the original safe error.
              deliveryFailure = error
            }
          })
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally { client.release() }
    })
    if (deliveryFailure) throw deliveryFailure
  } catch (error) {
    console.error('phone_push_failed', { code: error instanceof Error && 'code' in error && typeof error.code === 'string' && /^cloud_[a-z_]+$/.test(error.code) ? error.code : 'push_unavailable' })
  }
}
