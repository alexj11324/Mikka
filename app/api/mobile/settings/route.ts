import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { and, eq, isNull } from 'drizzle-orm'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { db } from '@/lib/db'
import { coordinatorSessions, linearConnections, users } from '@/lib/db/schema'
import { COMPOSIO_TOOLKITS, getComposio, isComposioToolkit } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { readPreferences } from '@/lib/preferences'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { listOrganizations } from '@/lib/governance/organizations'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { isCloudEdition } from '@/lib/edition'
import { mobileMembersPage } from '@/lib/mobile-web-target'
import { mobilePluginConnections } from '@/lib/mobile-plugin-connections'
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
  const view = new URL(request.url).searchParams.get('view')
  if (view === 'pluginConnections') return json(await mobilePluginConnections(user.id, request.headers))
  // 记忆 is the memory of the Coordinator of the workspace the app has open.
  const coordinator = await openChatBotId(user, null)
  const [context, preferences, [profile], apps] = await Promise.all([
    loadWorkspaceContext(undefined, user),
    readPreferences(user.id),
    db.select({ id: users.id, name: users.name, email: users.email, image: users.image, memory: coordinatorSessions.memory })
      .from(users)
      .leftJoin(coordinatorSessions, and(eq(coordinatorSessions.userId, users.id), eq(coordinatorSessions.botId, coordinator)))
      .where(eq(users.id, user.id)).limit(1),
    view === 'profile' ? [] : connectedApps(user.id),
  ])
  if (!profile) return unauthorized()
  const organization = context.role === 'admin' ? null : (await listOrganizations(user.id)).find(item => item.role === 'owner' || item.role === 'admin')
  return json({
    billingScope: context.role === 'admin' ? { kind: 'workspace', id: context.workspace.id } : organization ? { kind: 'organization', id: organization.id } : null,
    user: { id: profile.id, name: profile.name, email: profile.email, image: profile.image },
    workspace: {
      ...context.workspace,
      ...(isCloudEdition() && user[enterprisePrincipal]?.kind === 'session' && context.workspace.kind === 'team' && context.role === 'admin' && {
        serviceIdentityManagementPath: `${mobileMembersPage}?workspace=${context.workspace.id}`,
      }),
    },
    workspaces: context.choices,
    preferences,
    // The session's updatedAt moves with every turn, so the memory carries no 更新于 time.
    memory: profile.memory ?? '',
    apps,
  })
}

export const GET = withRequestLog('/api/mobile/settings', handleGET)
