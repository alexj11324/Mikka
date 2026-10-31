import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { workspaceAppPolicies } from '@/lib/db/app-policy-schema'
import { bots } from '@/lib/db/schema'
import { recordAudit } from '@/lib/audit/record'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { POLICY_APPS, setAppPolicyInput, type AppAccess, type PolicyApp, type PolicyToolkitId } from './apps'

export interface AppPolicyView { apps: Array<{ app: PolicyApp; access: AppAccess }>; canEdit: boolean }

async function readAccess(workspaceId: string): Promise<Map<PolicyToolkitId, AppAccess>> {
  const rows = await db.select({ app: workspaceAppPolicies.app, access: workspaceAppPolicies.access }).from(workspaceAppPolicies).where(eq(workspaceAppPolicies.workspaceId, workspaceId))
  return new Map(rows.map(row => [row.app, row.access]))
}

/** Any member reads; `canEdit` for admins (S-P: members see the values without controls). */
export async function getAppPolicies(actorId: string, workspaceId: string): Promise<AppPolicyView> {
  const { membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  const access = await readAccess(workspaceId)
  return { apps: POLICY_APPS.map(app => ({ app, access: access.get(app) ?? 'allow' })), canEdit: membership.role === 'admin' }
}

/** Admins only. The change and its audit row commit together. Errors: workspaceAccessDenied, validationGeneric. */
export async function setAppPolicy(actor: { id: string; name: string }, workspaceId: string, input: unknown, request: { ip?: string | null; geoCity?: string | null; geoCountry?: string | null; geoRegion?: string | null } = {}, now = new Date()): Promise<AppPolicyView> {
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
  return getAppPolicies(actor.id, workspaceId)
}

/**
 * The enforcement point: may this bot use this app? The personal Coordinator
 * (botId null) belongs to no workspace and is not governed here. A bot whose
 * row is gone is refused.
 */
export async function botMayUseApp(botId: string | null | undefined, app: PolicyToolkitId): Promise<boolean> {
  if (!botId) return true
  const [row] = await db.select({ access: workspaceAppPolicies.access, workspaceId: bots.workspaceId }).from(bots)
    .leftJoin(workspaceAppPolicies, and(eq(workspaceAppPolicies.workspaceId, bots.workspaceId), eq(workspaceAppPolicies.app, app)))
    .where(eq(bots.id, botId)).limit(1)
  if (!row) return false
  return row.access !== 'deny'
}
