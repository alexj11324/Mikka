import type { Pool, PoolClient } from 'pg'
import type { hostedBillingScope } from '@/lib/abuse/context'
import { MICRO_USD_PER_POINT } from '@/lib/abuse/policy'

export type BudgetScope = 'workspace' | 'member' | 'project' | 'thread' | 'run'
export type BudgetPeriod = 'month' | 'day' | 'lifetime'
export type BillingAttribution = NonNullable<ReturnType<typeof hostedBillingScope.getStore>>
export type ResourceBudgetView = { id: string; workspaceId: string; scope: BudgetScope; scopeId: string; period: BudgetPeriod;
  limitPoints: number; warningPercent: number; spentPoints: number; reservedPoints: number; committedPoints: number;
  remainingPoints: number; thresholdReached: boolean; exhausted: boolean }

/** Same receipt ledger, including unknown-cost holds; no estimates are reported as settled charges. */
export async function readResourceBudgets(query: Pick<Pool | PoolClient, 'query'>, workspaceIds: string[]): Promise<ResourceBudgetView[]> {
  const { rows } = await query.query<Omit<ResourceBudgetView, 'spentPoints' | 'reservedPoints' | 'committedPoints' | 'remainingPoints' | 'thresholdReached' | 'exhausted'> & { spent: number; held: number }>(`SELECT b.id,b."workspaceId",b.scope,b."scopeId",b.period,b."limitPoints",b."warningPercent",
    COALESCE(usage.spent,0)::float8 AS spent,COALESCE(usage.held,0)::float8 AS held
    FROM billing_resource_budgets b LEFT JOIN LATERAL (SELECT
      sum(CASE WHEN u.state='settled' THEN COALESCE(u."costMicroUsd",0) ELSE 0 END) AS spent,
      sum(CASE WHEN u.state IN ('pending','unknown') THEN COALESCE(u."costMicroUsd",u."holdMicroUsd") ELSE 0 END) AS held
      FROM hosted_usage u WHERE ((b.scope='workspace' AND u."workspaceId"=b."workspaceId") OR COALESCE(u."usageWorkspaceId",u."workspaceId")=b."workspaceId")
      AND (b.scope='workspace' OR (b.scope='member' AND u."actorId"=b."scopeId") OR (b.scope='project' AND u."usageProjectId"::text=b."scopeId")
        OR (b.scope='thread' AND u."usageThreadId"::text=b."scopeId") OR (b.scope='run' AND u."usageRunId"::text=b."scopeId"))
      AND u.state<>'failed' AND u."createdAt">=CASE b.period WHEN 'month' THEN date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        WHEN 'day' THEN date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ELSE 'epoch'::timestamptz END) usage ON true
    WHERE b."workspaceId"=ANY($1::uuid[]) ORDER BY b.scope,b."scopeId",b.period`, [workspaceIds])
  return rows.map(({ spent, held, ...row }) => { const spentPoints = spent / MICRO_USD_PER_POINT, reservedPoints = held / MICRO_USD_PER_POINT, committedPoints = spentPoints + reservedPoints
    return { ...row, spentPoints, reservedPoints, committedPoints, remainingPoints: Math.max(0, row.limitPoints - committedPoints),
      thresholdReached: committedPoints >= row.limitPoints * row.warningPercent / 100, exhausted: committedPoints >= row.limitPoints }
  })
}

export async function resourceBudgetAdmission(query: Pick<Pool | PoolClient, 'query'>, accountWorkspaceId: string, attribution: BillingAttribution, estimate: number, requireCompleteAttribution = true): Promise<boolean> {
  const budgets = await readResourceBudgets(query, [...new Set([accountWorkspaceId, attribution.workspaceId])])
  const scopeIds: Record<BudgetScope, string | null | undefined> = { workspace: attribution.workspaceId, member: attribution.actorId,
    project: attribution.projectId, thread: attribution.threadId, run: attribution.runId }
  for (const budget of budgets) {
    if (budget.scope !== 'workspace') {
      if (budget.workspaceId !== attribution.workspaceId) continue
      // Dropping actor/resource IDs must never bypass a configured narrower cap.
      if (requireCompleteAttribution && !attribution.attributionComplete) return false
      if (budget.scopeId !== scopeIds[budget.scope]) continue
    }
    if (budget.exhausted || budget.remainingPoints * MICRO_USD_PER_POINT < estimate) return false
  }
  return true
}
