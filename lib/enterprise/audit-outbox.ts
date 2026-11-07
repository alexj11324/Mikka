import 'server-only'
import type { PoolClient } from 'pg'
import { pool } from '../db'
import { workspaceDb } from '../workspace-db'
import { enqueueOrganizationAudit, organizationAuditRow, type OrganizationAuditInput } from '../governance/audit'
import { armDueTimerSoon } from '../due-timer'

type Receipt = ReturnType<typeof organizationAuditRow>
export async function enqueueIdentityAudit(tx: Pick<PoolClient, 'query'>, input: OrganizationAuditInput) {
  const row = organizationAuditRow(input)
  await tx.query('insert into enterprise_audit_outbox (id,"organizationId",payload) values ($1,$2,$3)', [row.id, row.organizationId, row])
}

/** Authentication configuration and its audit intent commit together in the auth database. */
export async function commitIdentityChange<T>(input: OrganizationAuditInput, work: (tx: PoolClient) => Promise<T>, options: { deferDelivery?: boolean } = {}) {
  const tx = await pool.connect()
  let value: T
  try {
    await tx.query('begin')
    await tx.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
    value = await work(tx)
    await enqueueIdentityAudit(tx, input)
    await tx.query('commit')
  } catch (error) { await tx.query('rollback'); throw error } finally { tx.release() }
  armDueTimerSoon('audit-retention')
  if (!options.deferDelivery) await deliverIdentityAudits(input.organizationId)
  return value
}

/** Stable IDs make delivery idempotent across either database failing after a commit. */
export async function deliverIdentityAudits(organizationId?: string, force = true) {
  const client = await pool.connect()
  let delivered = 0, failed = 0
  try {
    for (let index = 0; index < 100; index++) {
      await client.query('begin')
      try {
        const { rows: [event] } = await client.query<{ id: string; organizationId: string; payload: Omit<Receipt, 'createdAt'> & { createdAt: string } }>(`select id,"organizationId",payload from enterprise_audit_outbox
          where "deliveredAt" is null and ($1::uuid is null or "organizationId"=$1) and ($2 or "lastAttemptAt" is null or "lastAttemptAt"<=now()-interval '30 seconds')
          order by "createdAt",id for update skip locked limit 1`, [organizationId ?? null, force])
        if (!event) { await client.query('commit'); break }
        await client.query('update enterprise_audit_outbox set "lastAttemptAt"=now() where id=$1', [event.id])
        try {
          const row = event.payload
          if (row.id !== event.id || row.organizationId !== event.organizationId) throw new Error('enterprise_audit_scope_mismatch')
          await workspaceDb.transaction(tx => enqueueOrganizationAudit(tx, { organizationId: event.organizationId, eventId: event.id,
            actorId: row.actorId, action: row.action, targetId: row.targetId ?? undefined, metadata: row.metadata,
            result: row.result, correlationId: row.correlationId, occurredAt: new Date(row.createdAt) }))
        } catch {
          await client.query('commit'); failed++; break
        }
        await client.query('update enterprise_audit_outbox set "deliveredAt"=now(),payload=null where id=$1', [event.id])
        await client.query('commit'); delivered++
      } catch (error) { await client.query('rollback'); throw error }
    }
  } finally { client.release() }
  return { delivered, failed }
}
