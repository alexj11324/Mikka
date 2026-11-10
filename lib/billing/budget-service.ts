import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { recordAudit } from '@/lib/audit/write'
import { readResourceBudgets } from './resource-budgets'

const budgetInput = z.object({ scope: z.enum(['workspace', 'member', 'project', 'thread', 'run']), scopeId: z.string().min(1).max(200),
  period: z.enum(['month', 'day', 'lifetime']), limitPoints: z.number().int().min(0).max(100_000_000).nullable(),
  warningPercent: z.number().int().min(1).max(100).default(80) }).strict()

export async function workspaceBudgetView(actorId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
  return { budgets: await readResourceBudgets(pool, [workspaceId]) }
}

/** Budget managers see resource IDs and totals, never private conversation content. */
export async function setWorkspaceBudget(actorId: string, workspaceId: string, input: unknown) {
  const value = budgetInput.parse(input)
  await workspaceDb.transaction(async ws => {
    const { membership } = await requireWorkspace(ws, workspaceId, actorId, true)
    if (value.scope === 'workspace' && value.scopeId !== workspaceId) throw new WorkspaceError('workspaceAccessDenied')
    if (value.scope === 'member') {
      const [member] = await ws.select({ id: workspaceMembers.userId }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, value.scopeId), eq(workspaceMembers.status, 'active'))).limit(1)
      if (!member) throw new WorkspaceError('workspaceAccessDenied')
    }
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))`)
      if (value.scope === 'project' || value.scope === 'thread' || value.scope === 'run') {
        const id = z.uuid().parse(value.scopeId), kind = value.scope === 'project' ? 'project' : 'thread'
        // Authoritative APP ACL metadata avoids crossing the Workspace DB tenant boundary.
        const resource = await tx.execute(sql`select 1 from resource_access_policies where "workspaceId"=${workspaceId}::uuid and kind=${kind} and id=${id}::uuid limit 1`)
        if (!resource.rows.length) throw new WorkspaceError('workspaceAccessDenied')
      }
      const prior = await tx.execute<{ limitPoints: number }>(sql`select "limitPoints" from billing_resource_budgets where "workspaceId"=${workspaceId}::uuid and scope=${value.scope} and "scopeId"=${value.scopeId} and period=${value.period} for update`)
      if (value.limitPoints === null) await tx.execute(sql`delete from billing_resource_budgets where "workspaceId"=${workspaceId}::uuid and scope=${value.scope} and "scopeId"=${value.scopeId} and period=${value.period}`)
      else await tx.execute(sql`insert into billing_resource_budgets (id,"workspaceId",scope,"scopeId",period,"limitPoints","warningPercent","updatedBy")
        values (${randomUUID()}::uuid,${workspaceId}::uuid,${value.scope},${value.scopeId},${value.period},${value.limitPoints},${value.warningPercent},${actorId})
        on conflict ("workspaceId",scope,"scopeId",period) do update set "limitPoints"=excluded."limitPoints","warningPercent"=excluded."warningPercent","updatedBy"=excluded."updatedBy","updatedAt"=now()`)
      await recordAudit(tx, { workspaceId, actor: { type: 'user', id: actorId, name: membership.name }, action: 'billing.limits_changed',
        target: { type: `budget_${value.scope}`, id: value.scopeId }, metadata: { fromCents: prior.rows[0]?.limitPoints ?? null, toCents: value.limitPoints } })
    })
  })
  return workspaceBudgetView(actorId, workspaceId)
}
