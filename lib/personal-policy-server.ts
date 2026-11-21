import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { stopRunsUsingApiKeys } from '@/lib/model-api-key-runs'
import { memberSubscriptionsAllowed } from '@/lib/personal-policy'

/** 团队权限 › 订阅与 API Key: may members share their API keys with teammates (decision 2026-11-01-2240). Subscriptions are never shared (decision 2026-11-17). */
export interface MemberSubscriptionPolicy { allowed: boolean; canEdit: boolean }

/** Any member reads; `canEdit` for admins of a team workspace (a personal workspace has no switch). */
export async function getMemberSubscriptionPolicy(actorId: string, workspaceId: string): Promise<MemberSubscriptionPolicy> {
  const { workspace, membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  return { allowed: await memberSubscriptionsAllowed(pool, workspaceId), canEdit: membership.role === 'admin' && workspace.kind === 'team' }
}

/** Admins of a team workspace only. The change and its audit row commit together. */
export async function setMemberSubscriptionPolicy(actor: { id: string; name: string }, workspaceId: string, input: unknown, request: { ip?: string | null; geoCity?: string | null; geoCountry?: string | null; geoRegion?: string | null } = {}): Promise<MemberSubscriptionPolicy> {
  const allowed = z.boolean().parse(input)
  const { workspace } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actor.id, true))
  if (workspace.kind !== 'team') throw new WorkspaceError('validationGeneric')
  await db.transaction(async tx => {
    const { rows: [current] } = await tx.execute<{ subscriptions: boolean }>(sql`SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=${workspaceId} FOR UPDATE`)
    const previous = current?.subscriptions ?? true
    if (previous === allowed) return
    await tx.execute(sql`INSERT INTO workspace_personal_policies ("workspaceId",subscriptions,"updatedBy","updatedAt") VALUES (${workspaceId},${allowed},${actor.id},now())
      ON CONFLICT ("workspaceId") DO UPDATE SET subscriptions=EXCLUDED.subscriptions,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=now()`)
    await recordAudit(tx, { workspaceId, actor: { type: 'user', id: actor.id, name: actor.name }, action: 'integration.permission_changed', target: { type: 'personal', id: 'subscriptions', label: 'subscriptions' }, metadata: { integration: 'personal_subscriptions', capability: 'use', from: previous ? 'allow' : 'deny', to: allowed ? 'allow' : 'deny' } , ...request })
  })
  // Off: runs here on another member's shared API key stop now. A member's own runs on their own credentials go on (decision 2026-11-01-2240).
  if (!allowed) await stopRunsUsingApiKeys(pool, { workspaceId, othersOnly: true })
  return getMemberSubscriptionPolicy(actor.id, workspaceId)
}
