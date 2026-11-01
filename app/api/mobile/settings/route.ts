import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { and, eq, isNull } from 'drizzle-orm'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { coordinatorSessions, linearConnections } from '@/lib/db/schema'
import { COMPOSIO_TOOLKITS, getComposio, isComposioToolkit } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { readPreferences } from '@/lib/preferences'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

const APPS = [...COMPOSIO_TOOLKITS, 'linear'] as const
type App = (typeof APPS)[number]

/** Which apps the person connected: Composio's (Gmail, Calendar, Notion, Slack) and Linear. Connecting happens on the web. */
async function connectedApps(userId: string): Promise<{ app: App; connected: boolean; account: string | null }[]> {
  const composio = getComposio()
  const composioAccounts = composio
    ? await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor })).catch(() => [])
    : []
  const active = new Set(composioAccounts.filter(account => isComposioToolkit(account.toolkit.slug) && account.status === 'ACTIVE').map(account => account.toolkit.slug))
  const [linear] = await db.select({ organizationName: linearConnections.organizationName }).from(linearConnections)
    .where(and(eq(linearConnections.userId, userId), isNull(linearConnections.revokedAt))).limit(1)
  return APPS.map(app => app === 'linear'
    ? { app, connected: Boolean(linear), account: linear?.organizationName ?? null }
    : { app, connected: active.has(app), account: null })
}

/**
 * `GET /api/mobile/settings`: everything the app's Settings pages show
 * (docs/design/mobile.md, "Settings"): profile, workspaces, 通知 and 记忆
 * settings, the Coordinator's memory as Markdown, and connected apps.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  // 记忆 is the memory of the Coordinator of the workspace the app has open.
  const coordinator = await openChatBotId(user, null)
  const [context, preferences, [session], apps] = await Promise.all([
    loadWorkspaceContext(undefined, user),
    readPreferences(user.id),
    db.select({ memory: coordinatorSessions.memory }).from(coordinatorSessions)
      .where(and(eq(coordinatorSessions.userId, user.id), eq(coordinatorSessions.botId, coordinator))).limit(1),
    connectedApps(user.id),
  ])
  return json({
    user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
    workspace: context.workspace,
    workspaces: context.choices,
    preferences,
    // The session's updatedAt moves with every turn, so the memory carries no 更新于 time.
    memory: session?.memory ?? '',
    apps,
  })
}

export const GET = withRequestLog('/api/mobile/settings', handleGET)
