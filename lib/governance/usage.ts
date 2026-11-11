import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { requireWorkspace } from '@/lib/workspace-access'
import { readGovernanceLease } from './lease'
import { requireGovernanceFeature } from './entitlements'
import { GovernanceError } from './errors'
import { csvCell } from './policy'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { enterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'

/**
 * Every dimension this report can answer by. `day` and `model` are always
 * present in a row; `member` and `repository` subdivide on top of them, which
 * keeps each row a dated point a chart can plot.
 */
export const USAGE_GROUP_BY = ['day', 'model', 'member', 'repository'] as const
export type UsageGroupBy = (typeof USAGE_GROUP_BY)[number]
/** The optional subdivisions. Anything else in USAGE_GROUP_BY is always there. */
export const USAGE_SUBDIVISIONS = ['member', 'repository'] as const
export type UsageSubdivision = (typeof USAGE_SUBDIVISIONS)[number]

export type UsageRow = {
  day: string
  model: string
  /** Set when grouped by member; null otherwise. */
  memberId: string | null
  /** The repository key when grouped by repository and the run recorded one. */
  repository: string | null
  requests: number
  /** Settled rows whose cost the provider never reported. They count as requests and cost 0 here. */
  unknownRequests: number
  inputTokens: string
  outputTokens: string
  /** Null when no row in this group recorded a breakdown; see cacheCollectedRequests to tell that from a real zero. */
  cacheReadTokens: string | null
  cacheWriteTokens: string | null
  /** How many rows actually reported cache figures, so a mostly-null column cannot read as a cheap one. */
  cacheCollectedRequests: number
  costMicroUsd: string
  freeMicroUsd: string
  purchasedMicroUsd: string
}

export function usageRange(input: { from?: string | null; to?: string | null }, now = new Date()) {
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
  const to = input.to ? new Date(date.parse(input.to)) : new Date(now.toISOString().slice(0, 10))
  const from = input.from ? new Date(date.parse(input.from)) : new Date(to.getTime() - 29 * 86400000)
  if (from > to || to.getTime() - from.getTime() >= 93 * 86400000) throw new GovernanceError('invalid_request')
  return { from, to: new Date(to.getTime() + 86400000) }
}

/** Unknown is not zero: an omitted subdivision keeps the response exactly as it was. */
export function usageSubdivision(input: string | null | undefined): UsageSubdivision | null {
  if (input === null || input === undefined || input === '') return null
  const match = USAGE_SUBDIVISIONS.find(value => value === input)
  if (!match) throw new GovernanceError('invalid_request')
  return match
}

/**
 * Actual hosted ledger only: BYOS runs never acquire a synthetic cost or charge here.
 *
 * `inputTokens` already includes cached input, so `cacheReadTokens` and
 * `cacheWriteTokens` are a breakdown of one call's input and must never be added
 * to it (see drizzle/20261111060000_hosted_usage_token_breakdown.sql).
 */
export async function readWorkspaceUsage(workspaceId: string, reader: string | EnterpriseReader,
  range: { from?: string | null; to?: string | null }, groupBy: string | null | undefined = null) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const { from, to } = usageRange(range)
  const subdivision = usageSubdivision(groupBy)
  // Match task writers' WS -> APP order. workspacePool reuses the pinned
  // workspace transaction, including composed reads with a bounded pool.
  return withTaskWorkspace(reader, workspaceId, () => writeTransaction(pool, async tx => {
    const scope = await readGovernanceLease(workspacePool, workspaceId, userId)
    if (scope.role !== 'admin') throw new GovernanceError('access_denied')
    if (!scope.entitlements.usageExport) throw new GovernanceError('feature_unavailable')
    // The subdivision is a closed enum, so only a constant reaches the projection.
    const memberColumn = subdivision === 'member' ? 'u."actorId"' : 'null::text'
    // A repository needs the run that produced the call, then that run's checkout.
    // Both hops are nullable and both are recorded only when attribution completed,
    // so an unattributed call groups under a null repository instead of vanishing.
    // Joining only when asked keeps the unsubdivided report on its existing plan:
    // hosted_usage (workspaceId, createdAt) alone.
    const repositoryColumn = subdivision === 'repository' ? 'd."repoPath"' : 'null::text'
    const joins = subdivision === 'repository'
      ? 'left join agent_runs r on r.id = u."usageRunId" left join device_repos d on d.id = r."deviceRepoId"'
      : ''
    const { rows } = await tx.query<UsageRow>(`select to_char(u."createdAt" at time zone 'UTC','YYYY-MM-DD') as day,u.model as model,
      ${memberColumn} as "memberId",${repositoryColumn} as repository,
      count(*)::int as requests,
      count(*) filter (where u."costMicroUsd" is null)::int as "unknownRequests",
      coalesce(sum(u."inputTokens"),0)::text as "inputTokens",coalesce(sum(u."outputTokens"),0)::text as "outputTokens",
      sum(u."cacheReadTokens")::text as "cacheReadTokens",sum(u."cacheWriteTokens")::text as "cacheWriteTokens",
      count(u."cacheReadTokens")::int as "cacheCollectedRequests",
      coalesce(sum(u."costMicroUsd"),0)::text as "costMicroUsd",coalesce(sum(u."freeMicroUsd"),0)::text as "freeMicroUsd",
      coalesce(sum(u."purchasedMicroUsd"),0)::text as "purchasedMicroUsd"
      from hosted_usage u ${joins}
      where u."workspaceId"=$1 and u."createdAt">=$2 and u."createdAt"<$3 and u.state='settled'
      group by 1,2,3,4 order by 1,2,3,4 limit 50001`, [workspaceId, from, to])
    if (rows.length > 50000) throw new GovernanceError('invalid_request')
    const { rows: runs } = await tx.query<{ status: string; count: number }>('select status,count(*)::int as count from agent_runs where "workspaceId"=$1 and "createdAt">=$2 and "createdAt"<$3 group by status order by status', [workspaceId, from, to])
    // availableGroupBy tells a new client what this report can be asked for without
    // reading the source, so the dimensions added here are discoverable rather than
    // sitting unused because nobody knew to pass a parameter.
    return { from: from.toISOString(), toExclusive: to.toISOString(), currency: 'USD', costUnit: 'microUSD',
      groupBy: subdivision, availableGroupBy: [...USAGE_GROUP_BY], hosted: rows, runs }
  }))
}

const USAGE_COLUMNS: (keyof UsageRow)[] = ['day', 'model', 'memberId', 'repository', 'requests', 'unknownRequests',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheCollectedRequests',
  'costMicroUsd', 'freeMicroUsd', 'purchasedMicroUsd']

export async function exportWorkspaceUsage(workspaceId: string, reader: string | EnterpriseReader,
  range: { from?: string | null; to?: string | null }, groupBy: string | null | undefined = null) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const usage = await readWorkspaceUsage(workspaceId, reader, range, groupBy)
  // An unrequested subdivision stays out of the CSV rather than as a column of nulls.
  const columns = USAGE_COLUMNS.filter(key => (key !== 'memberId' && key !== 'repository') || usage.groupBy === (key === 'memberId' ? 'member' : 'repository'))
  const csv = [columns.map(csvCell).join(','), ...usage.hosted.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n'
  await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, userId, true, typeof reader === 'string' ? undefined : reader[enterprisePrincipal])
    await requireGovernanceFeature(tx, workspaceId, 'usageExport')
    await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: userId, name: membership.name }, action: 'audit.exported', target: { type: 'usage' }, metadata: { count: usage.hosted.length, digest: createHash('sha256').update(csv).digest('hex') } })
  })
  return csv
}
