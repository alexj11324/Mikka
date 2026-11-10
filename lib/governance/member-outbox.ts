import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { governanceMemberOutbox } from '@/lib/db/governance-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

export async function enqueueMemberLifecycle(tx: Pick<WorkspaceTransaction, 'insert'>, workspaceId: string, userId: string, operation: 'suspend' | 'restore') {
  await tx.insert(governanceMemberOutbox).values({ id: randomUUID(), workspaceId, userId, operation })
  armDueTimerAfterCommit(tx, 'audit-retention')
}

/** WS -> APP, including callers already inside the directory delivery lease.
 * Reuse that transaction rather than checking out a second WS connection.
 * Stable membership and the outbox ACK commit together; APP cleanup is
 * idempotent if that WS commit fails and the durable intent is retried. */
export async function drainMemberLifecycleOutbox(workspaceId: string, userId: string) {
  await workspaceDb.transaction(async tx => {
    await tx.execute(sql`select id from mikka_workspaces where id=${workspaceId} for share`)
    const key = `governance-member:${workspaceId}:${userId}`
    const lock = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`)
    if (!lock.rows[0]?.acquired) return
    const { rows } = await tx.execute<{ id: string }>(sql`select id from mikka_governance_member_outbox
      where "workspaceId"=${workspaceId} and "userId"=${userId} and "deliveredAt" is null order by "createdAt",id limit 100`)
    if (!rows.length) return
    const { rows: [member] } = await tx.execute<{ status: string }>(sql`select status from mikka_workspace_members
      where "workspaceId"=${workspaceId} and "userId"=${userId} for share`)
    const { releaseDepartingMember, restoreReturningMember } = await import('@/lib/workspace-admin/members')
    // A newer committed membership state wins over an older retry's request.
    if (member?.status === 'active') await restoreReturningMember(workspaceId, userId)
    else {
      const { pool } = await import('@/lib/db')
      await pool.query('update personal_access_tokens set "revokedAt"=now() where "userId"=$1 and "workspaceId"=$2 and "revokedAt" is null', [userId, workspaceId])
      await pool.query('update run_tokens t set "revokedAt"=now() from agent_runs r where r.id=t."runId" and t."userId"=$1 and r."workspaceId"=$2 and t."revokedAt" is null', [userId, workspaceId])
      await releaseDepartingMember(workspaceId, userId)
    }
    await tx.execute(sql`update mikka_governance_member_outbox set "deliveredAt"=now() where id in ${rows.map(row => row.id)}`)
  })
}

/** Bounded background retry, also used after a synchronous drain fails. */
export async function retryMemberLifecycleOutbox() {
  const { workspacePool } = await import('@/lib/workspace-db')
  const { rows } = await workspacePool.query<{ workspaceId: string; userId: string }>('select "workspaceId","userId" from mikka_governance_member_outbox where "deliveredAt" is null group by "workspaceId","userId" order by min("createdAt") limit 50')
  for (const row of rows) await drainMemberLifecycleOutbox(row.workspaceId, row.userId)
  return rows.length
}
