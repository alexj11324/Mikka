import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { lockLiveRegistration } from '@/lib/enterprise/live-store'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { agentRuns, bots } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
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
    const candidates = await pool.query<{ sessionId: string }>(
      'SELECT DISTINCT "sessionId" FROM mobile_push_tokens WHERE "userId"=$1 AND "sessionId" IS NOT NULL ORDER BY "sessionId"', [userId])
    let deliveryFailure: CloudServiceError | undefined
    // The receiver's persisted session, not the caller's ambient credential,
    // must pass the tenant gate before any APP transaction is checked out.
    for (const { sessionId } of candidates.rows) {
      const principal: EnterprisePrincipal = { kind: 'session', sessionId }
      const reader = { id: userId, [enterprisePrincipal]: principal, [tokenWorkspace]: origin.workspaceId }
      try {
        await withTaskWorkspace(reader, origin.workspaceId, async (_workspace, workspaceTx) => {
          const [link] = await workspaceTx.select({ organizationId: organizationWorkspaces.organizationId })
            .from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, origin.workspaceId)).limit(1)
          const organizationId = link?.organizationId ?? null
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            try {
              await withDatabaseClient(client, async () => {
                // Policy/SCIM use Org exclusive; native session revocation
                // takes session exclusive after its row lock. Never acquire a
                // session row/FK lock after these advisory locks.
                if (organizationId) await lockLiveRegistration(client, organizationId, sessionId)
                const session = await client.query(
                  'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp()' + (organizationId ? '' : ' FOR SHARE'),
                  [sessionId, userId])
                if (!session.rowCount) return
                if (!await enterpriseWorkspaceAllowed(userId, origin.workspaceId, principal, workspaceTx, client)) return
                if (!pushAllowed(await readPreferences(userId), reasons)) return
                if (await chatMuted(userId, botId)) return
                const [bot] = await db.select({ name: bots.name, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` }).from(bots)
                  .where(and(eq(bots.id, botId), eq(bots.ownerId, userId), eq(bots.workspaceId, origin.workspaceId), isNull(bots.archivedAt))).limit(1).for('share')
                if (!bot) return
                // UPDATE also serializes provider-driven invalid-token deletion.
                const destinations = await client.query<{ token: string }>(
                  'SELECT token FROM mobile_push_tokens WHERE "userId"=$1 AND "sessionId"=$2 ORDER BY id FOR UPDATE', [userId, sessionId])
                if (!destinations.rows.length) return
                const locale = await personLocale(userId)
                const body = text === null ? await codePushBody(locale) : pushBody(text)
                if (task) {
                  // Historical event ids are routing hints, not current authority.
                  // Reuse this phone's explicit session reader and the held clients.
                  const issue = await issueForUser(reader, task.issueId, false, db, { withoutBody: true })
                  if (!issue || issue.workspaceId !== origin.workspaceId) return
                  if (task.runId) {
                    const [run] = await db.select({ id: agentRuns.id }).from(agentRuns)
                      .where(and(eq(agentRuns.id, task.runId), eq(agentRuns.userId, userId),
                        eq(agentRuns.issueId, issue.id), eq(agentRuns.workspaceId, origin.workspaceId))).limit(1)
                    if (!run) return
                  }
                }
                // Expiry is wall-clock time, including target reads and token-lock waits.
                const fresh = await client.query(
                  'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp()', [sessionId, userId])
                if (!fresh.rowCount) return
                try {
                  await deliverPhonePush(userId, { to: destinations.rows.map(row => row.token), title: bot.coordinator ? 'Coordinator' : bot.name, body,
                    data: { botId: bot.coordinator ? null : botId, serverUrl: appOrigin + BASE_PATH, userId,
                      ...(task ? { workspaceId: origin.workspaceId, issueId: task.issueId, ...(task.runId ? { runId: task.runId } : {}) } : {}) }, collapseId: botId }, locale)
                } catch (error) {
                  if (!(error instanceof CloudServiceError)) throw error
                  // Accepted receipts must commit even if another destination
                  // was rejected. Other authorized phones still get their send.
                  deliveryFailure ??= error
                }
              })
              await client.query('COMMIT')
            } catch (error) {
              await client.query('ROLLBACK')
              throw error
            }
          } finally { client.release() }
        })
      } catch (error) {
        if ((error instanceof ActionFailureError || error instanceof WorkspaceError) && error.code === 'workspaceAccessDenied') continue
        throw error
      }
    }
    if (deliveryFailure) throw deliveryFailure
  } catch (error) {
    console.error('phone_push_failed', { code: error instanceof Error && 'code' in error && typeof error.code === 'string' && /^cloud_[a-z_]+$/.test(error.code) ? error.code : 'push_unavailable' })
  }
}
