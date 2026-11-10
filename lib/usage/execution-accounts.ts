import type { ExecutionIdentity } from '../execution-identity'

export type ExecutionAccountUsage = {
  id: string; kind: ExecutionIdentity['billingAccount']['model']['kind']; ownerId: string; ownerName: string
  amount: 'provider_unknown' | 'metered' | 'not_applicable'; runs: number; seconds: number
}

/** Historical rows without trustworthy provenance stay out of account attribution. No estimate is a charge. */
export function executionAccountUsage(rows: { identity: ExecutionIdentity | null; seconds: number }[]): ExecutionAccountUsage[] {
  const result = new Map<string, ExecutionAccountUsage>()
  for (const { identity, seconds } of rows) {
    if (!identity || (identity.version !== 1 && identity.version !== 2)) continue
    for (const lane of ['model', 'runtime'] as const) {
      const account = identity.billingAccount[lane]
      const id = JSON.stringify([lane, account.kind, account.ownerId, account.resourceId])
      const row = result.get(id) ?? { id, kind: account.kind, ownerId: account.ownerId, ownerName: account.ownerId, amount: account.amount, runs: 0, seconds: 0 }
      row.runs += 1; row.seconds += Math.max(0, Math.round(Number(seconds) || 0))
      result.set(id, row)
    }
  }
  return [...result.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.ownerId.localeCompare(b.ownerId) || a.id.localeCompare(b.id))
}
