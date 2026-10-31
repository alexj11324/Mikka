import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { and, eq, inArray } from 'drizzle-orm'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { memberSubscriptionsAllowed, pooledOwners, setSubscriptionShare } from '@/lib/personal-policy'

/** 团队权限 › 允许成员使用个人订阅. */
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
  return getMemberSubscriptionPolicy(actor.id, workspaceId)
}

/** 模型与额度 › 在这里使用我的订阅 and 分享给团队成员, plus who else lets this member's bots use theirs. */
export interface SubscriptionShareView {
  personal: boolean; shared: boolean; allowOthers: boolean; allowed: boolean
  /** Members whose subscriptions this member's bots may use here; names only, never the credential. */
  available: { name: string; provider: 'claude' | 'codex' }[]
  /** This member's own connected providers, named in the 分享给团队成员 confirmation. */
  own: ('claude' | 'codex')[]
}
export const shareInput = z.strictObject({ shared: z.boolean(), allowOthers: z.boolean().optional() })

export async function getSubscriptionShare(actorId: string, workspaceId: string): Promise<SubscriptionShareView> {
  const { workspace } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  // A personal workspace always uses its owner's subscriptions (loadWorkspaceContext keeps its share row).
  if (workspace.kind === 'personal') return { personal: true, shared: true, allowOthers: false, allowed: true, available: [], own: [] }
  const [row, allowed, owners, own] = await Promise.all([
    pool.query<{ allowOthers: boolean }>('SELECT "allowOthers" FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [actorId, workspaceId]),
    memberSubscriptionsAllowed(pool, workspaceId),
    pooledOwners(pool, actorId, workspaceId),
    pool.query<{ provider: 'claude' | 'codex' }>(`SELECT DISTINCT provider FROM byos_connections WHERE "ownerId"=$1 AND state='connected' AND "removedAt" IS NULL ORDER BY provider`, [actorId]),
  ])
  let available: SubscriptionShareView['available'] = []
  if (owners.length) {
    const [names, providers] = await Promise.all([
      workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, owners), eq(workspaceMembers.status, 'active'))),
      pool.query<{ ownerId: string; provider: 'claude' | 'codex' }>(`SELECT DISTINCT "ownerId",provider FROM byos_connections WHERE "ownerId"=ANY($1) AND state='connected' AND "removedAt" IS NULL`, [owners]),
    ])
    const byId = new Map(names.map(member => [member.userId, member.name]))
    available = owners.flatMap(owner => providers.rows.filter(row => row.ownerId === owner && byId.has(owner)).map(row => ({ name: byId.get(owner)!, provider: row.provider })))
  }
  return { personal: false, shared: Boolean(row.rowCount), allowOthers: Boolean(row.rows[0]?.allowOthers), allowed, available, own: own.rows.map(r => r.provider) }
}

export async function setOwnSubscriptionShare(actorId: string, workspaceId: string, input: unknown): Promise<SubscriptionShareView> {
  const { shared, allowOthers } = shareInput.parse(input)
  const { workspace } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  if (workspace.kind === 'personal') return getSubscriptionShare(actorId, workspaceId)
  if (shared && !(await memberSubscriptionsAllowed(pool, workspaceId))) throw new WorkspaceError('workspaceAccessDenied')
  await setSubscriptionShare(pool, actorId, workspaceId, shared, shared ? (allowOthers ?? false) : undefined)
  return getSubscriptionShare(actorId, workspaceId)
}
