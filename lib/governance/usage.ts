import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'
import { acquireWorkspaceMembership } from '@/lib/workspace-membership-guard'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { requireWorkspace } from '@/lib/workspace-access'
import { readGovernanceLease } from './lease'
import { requireGovernanceFeature } from './entitlements'
import { GovernanceError } from './errors'
import { csvCell } from './policy'
import { writeTransaction } from '@/lib/operations/write-transaction'

export type UsageRow = { day: string; model: string; requests: number; inputTokens: string; outputTokens: string; costMicroUsd: string; freeMicroUsd: string; purchasedMicroUsd: string }
export function usageRange(input: { from?: string | null; to?: string | null }, now = new Date()) {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
  const to = input.to ? new Date(date.parse(input.to)) : new Date(now.toISOString().slice(0, 10))
  const from = input.from ? new Date(date.parse(input.from)) : new Date(to.getTime() - 29 * 86400000)
  if (from > to || to.getTime() - from.getTime() >= 93 * 86400000) throw new GovernanceError('invalid_request')
  return { from, to: new Date(to.getTime() + 86400000) }
}

/** Actual hosted ledger only: BYOS runs never acquire a synthetic cost or charge here. */
export async function readWorkspaceUsage(workspaceId: string, userId: string, range: { from?: string | null; to?: string | null }) {
  const { from, to } = usageRange(range)
  // Acquire APP before workspace, matching hosted reservation and policy writes.
  // Holding workspace while waiting for an exhausted APP pool forms a cycle.
  return writeTransaction(pool, async () => ({
    from: from.toISOString(), toExclusive: to.toISOString(), currency: 'USD', costUnit: 'microUSD',
    hosted: [] as UsageRow[], runs: [] as { status: string; count: number }[],
  }), {
    guard: async (_tx, signal) => {
      const lease = await acquireWorkspaceMembership(workspacePool, { workspaceId, userId, pinWorkspace: true }, signal)
      try {
        const scope = await readGovernanceLease(lease.workspaceClient!, workspaceId, userId)
        if (scope.role !== 'admin') throw new GovernanceError('access_denied')
        if (!scope.entitlements.usageExport) throw new GovernanceError('feature_unavailable')
        return lease
      } catch (error) { await lease.close(); throw error }
    },
    guardedWork: async (tx, result) => {
      const { rows } = await tx.query<UsageRow>(`select to_char("createdAt" at time zone 'UTC','YYYY-MM-DD') as day,model,
        count(*)::int as requests,sum("inputTokens")::text as "inputTokens",sum("outputTokens")::text as "outputTokens",
        coalesce(sum("costMicroUsd"),0)::text as "costMicroUsd",sum("freeMicroUsd")::text as "freeMicroUsd",sum("purchasedMicroUsd")::text as "purchasedMicroUsd"
        from hosted_usage where "workspaceId"=$1 and "createdAt">=$2 and "createdAt"<$3 and state='settled'
        group by day,model order by day,model limit 50001`, [workspaceId, from, to])
      if (rows.length > 50000) throw new GovernanceError('invalid_request')
      const { rows: runs } = await tx.query<{ status: string; count: number }>('select status,count(*)::int as count from agent_runs where "workspaceId"=$1 and "createdAt">=$2 and "createdAt"<$3 group by status order by status', [workspaceId, from, to])
      return { ...result, hosted: rows, runs }
    },
  })
}

export async function exportWorkspaceUsage(workspaceId: string, userId: string, range: { from?: string | null; to?: string | null }) {
  const usage = await readWorkspaceUsage(workspaceId, userId, range)
  const columns: (keyof UsageRow)[] = ['day', 'model', 'requests', 'inputTokens', 'outputTokens', 'costMicroUsd', 'freeMicroUsd', 'purchasedMicroUsd']
  const csv = [columns.map(csvCell).join(','), ...usage.hosted.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n'
  await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, userId, true)
    await requireGovernanceFeature(tx, workspaceId, 'usageExport')
    await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: userId, name: membership.name }, action: 'audit.exported', target: { type: 'usage' }, metadata: { count: usage.hosted.length, digest: createHash('sha256').update(csv).digest('hex') } })
  })
  return csv
}
