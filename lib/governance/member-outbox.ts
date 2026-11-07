import 'server-only'
import { randomUUID } from 'node:crypto'
import { governanceMemberOutbox } from '@/lib/db/governance-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'

export async function enqueueMemberLifecycle(tx: Pick<WorkspaceTransaction, 'insert'>, workspaceId: string, userId: string, operation: 'suspend' | 'restore') {
  await tx.insert(governanceMemberOutbox).values({ id: randomUUID(), workspaceId, userId, operation })
}

/** No workspace transaction/row locks are held while APP revocation locks are acquired. */
export async function drainMemberLifecycleOutbox(workspaceId: string, userId: string) {
  const { workspacePool } = await import('@/lib/workspace-db')
  const client = await workspacePool.connect()
  const key = `governance-member:${workspaceId}:${userId}`
  try {
    // This session lock only serializes outbox workers; membership writers never take it.
    const { rows: [lock] } = await client.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as acquired', [key])
    if (!lock.acquired) return
    try {
      const { rows } = await client.query<{ id: string }>('select id from mikka_governance_member_outbox where "workspaceId"=$1 and "userId"=$2 and "deliveredAt" is null order by "createdAt",id limit 100', [workspaceId, userId])
      if (!rows.length) return
      const { rows: [member] } = await client.query<{ status: string }>('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [workspaceId, userId])
      const { releaseDepartingMember, restoreReturningMember } = await import('@/lib/workspace-admin/members')
      // A newer committed membership state wins over an older retry's requested state.
      if (member?.status === 'active') await restoreReturningMember(workspaceId, userId)
      else await releaseDepartingMember(workspaceId, userId)
      await client.query('update mikka_governance_member_outbox set "deliveredAt"=now() where id=any($1::uuid[])', [rows.map(row => row.id)])
    } finally { await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]) }
  } finally { client.release() }
}

/** Bounded background retry, also used after a synchronous drain fails. */
export async function retryMemberLifecycleOutbox() {
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows } = await workspacePool.query<{ workspaceId: string; userId: string }>('select "workspaceId","userId" from mikka_governance_member_outbox where "deliveredAt" is null group by "workspaceId","userId" order by min("createdAt") limit 50')
  for (const row of rows) await drainMemberLifecycleOutbox(row.workspaceId, row.userId)
  return rows.length
}
