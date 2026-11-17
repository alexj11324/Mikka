import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceAppPolicies } from '@/lib/db/app-policy-schema'
import { bots } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { recordAudit } from '@/lib/audit/record'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { policyRows, setAppPolicyInput, type AppAccess, type PolicyApp } from './apps'

export interface AppPolicyView {
  /** Every app the workspace's bots can reach (connected by an active member) and every app with a stored choice. */
  apps: Array<{ app: PolicyApp; access: AppAccess }>
  canEdit: boolean
  /** The members' connected apps could not be read from Composio just now; only stored choices are listed. */
  connectedUnavailable?: boolean
}

/** The Composio toolkits these people have an active, enabled account for, live from Composio. */
export type MembersAppsReader = (userIds: string[]) => Promise<string[]>

const MEMBER_CHUNK = 100

async function membersComposioApps(userIds: string[]): Promise<string[]> {
  const { getComposio } = await import('@/lib/composio')
  const { listComposioPages } = await import('@/lib/composio-pagination')
  const composio = getComposio()
  if (!composio || !userIds.length) return []
  const apps = new Set<string>()
  for (let index = 0; index < userIds.length; index += MEMBER_CHUNK) {
    const chunk = userIds.slice(index, index + MEMBER_CHUNK)
    const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: chunk, statuses: ['ACTIVE'], cursor }))
    for (const account of accounts) if (account.status === 'ACTIVE' && !account.isDisabled) apps.add(account.toolkit.slug)
  }
  return [...apps]
}

async function readAccess(workspaceId: string): Promise<Map<string, AppAccess>> {
  const rows = await db.select({ app: workspaceAppPolicies.app, access: workspaceAppPolicies.access }).from(workspaceAppPolicies).where(eq(workspaceAppPolicies.workspaceId, workspaceId))
  return new Map(rows.map(row => [row.app, row.access]))
}

/** Any member reads; `canEdit` for admins (S-P: members see the values without controls). */
export async function getAppPolicies(actorId: string, workspaceId: string, readMembersApps: MembersAppsReader = membersComposioApps): Promise<AppPolicyView> {
  const { membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  const [access, members] = await Promise.all([
    readAccess(workspaceId),
    workspaceDb.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active'))),
  ])
  let connected: string[] = []
  let connectedUnavailable = false
  try { connected = await readMembersApps(members.map(member => member.userId)) } catch (failure) {
    // The stored choices still show and still apply; the page says the rest could not be read.
    console.error('Workspace members\' connected apps unreadable', { cause: failure instanceof Error ? failure.name : 'unknown' })
    connectedUnavailable = true
  }
  return { apps: policyRows(access, connected), canEdit: membership.role === 'admin', ...(connectedUnavailable ? { connectedUnavailable } : {}) }
}

/** Admins only. The change and its audit row commit together. Errors: workspaceAccessDenied, validationGeneric. */
export async function setAppPolicy(actor: { id: string; name: string }, workspaceId: string, input: unknown, request: { ip?: string | null; geoCity?: string | null; geoCountry?: string | null; geoRegion?: string | null } = {}, now = new Date(), readMembersApps: MembersAppsReader = membersComposioApps): Promise<AppPolicyView> {
  const { app, access } = setAppPolicyInput.parse(input)
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actor.id, true))
  await db.transaction(async tx => {
    const [current] = await tx.select({ access: workspaceAppPolicies.access }).from(workspaceAppPolicies)
      .where(and(eq(workspaceAppPolicies.workspaceId, workspaceId), eq(workspaceAppPolicies.app, app))).for('update')
    const from = current?.access ?? 'allow'
    if (from === access) return
    await tx.insert(workspaceAppPolicies).values({ workspaceId, app, access, updatedBy: actor.id, updatedAt: now })
      .onConflictDoUpdate({ target: [workspaceAppPolicies.workspaceId, workspaceAppPolicies.app], set: { access, updatedBy: actor.id, updatedAt: now } })
    await recordAudit(tx, { workspaceId, actor: { type: 'user', id: actor.id, name: actor.name }, action: 'integration.permission_changed', target: { type: 'app', id: app, label: app }, metadata: { integration: app, capability: 'use', from, to: access }, ...request })
  })
  return getAppPolicies(actor.id, workspaceId, readMembersApps)
}

/**
 * The enforcement point: may this bot use this app? The person's Coordinator
 * is their own, one per person (lib/coordinator/coordinator-bot.ts), and is
 * not governed here, as before it had a bot row. Work with no bot (botId
 * null) is not either. A bot whose row is gone is refused.
 */
export async function botMayUseApp(botId: string | null | undefined, app: string): Promise<boolean> {
  if (!botId) return true
  const [row] = await db.select({ access: workspaceAppPolicies.access, workspaceId: bots.workspaceId, coordinator: sql<boolean>`exists (select 1 from coordinator_bots cb where cb."botId" = ${bots.id})` }).from(bots)
    .leftJoin(workspaceAppPolicies, and(eq(workspaceAppPolicies.workspaceId, bots.workspaceId), eq(workspaceAppPolicies.app, app)))
    .where(eq(bots.id, botId)).limit(1)
  if (!row) return false
  return row.coordinator || row.access !== 'deny'
}
