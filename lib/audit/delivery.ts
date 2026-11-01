import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { workspaceAuditEvents } from '@/lib/db/audit-schema'
import { workspaceAuditOutbox } from '@/lib/db/workspace-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { toAuditRow, AuditEventError, type AuditEvent, type AuditRow } from './events'
import { auditFailureSummary } from './record'
import { auditDigest } from './integrity'

export type AuditRequestContext = ReturnType<typeof import('./events').auditRequestContext>
/** Validate before the business transaction can commit; never store secrets or arbitrary payloads. */
export async function enqueueWorkspaceAudit(tx: Pick<WorkspaceTransaction, 'insert'>, event: AuditEvent) {
  const id = randomUUID()
  const payload = { ...toAuditRow(event), workspaceId: event.workspaceId.toLowerCase() }
  await tx.insert(workspaceAuditOutbox).values({ id, workspaceId: payload.workspaceId, payload, createdAt: new Date() })
  return id
}
type Targets = { main: Pool; workspace: Pool }
interface Receipt { id: string; workspaceId: string; payload: AuditRow; createdAt: Date }
function validatedPayload(receipt: Receipt): AuditRow {
  const p = receipt.payload
  const validated = toAuditRow({ workspaceId: receipt.workspaceId, actor: { type: p.actorType, id: p.actorId, name: p.actorName } as AuditEvent['actor'],
    action: p.action, target: p.targetType ? { type: p.targetType, id: p.targetId, label: p.targetLabel } : null,
    metadata: p.metadata, ip: p.ip, geoCity: p.geoCity, geoCountry: p.geoCountry, geoRegion: p.geoRegion })
  if (auditDigest(validated) !== auditDigest(p)) throw new AuditEventError('auditDeliveryPayloadChanged')
  return validated
}
async function writeAndReadBack(client: PoolClient, receipt: Receipt) {
  const payload = validatedPayload(receipt)
  await client.query('BEGIN')
  try {
    await drizzle(client).insert(workspaceAuditEvents).values({ id: receipt.id, ...payload, createdAt: receipt.createdAt }).onConflictDoNothing({ target: workspaceAuditEvents.id })
    const row = (await client.query<AuditRow & { id: string; createdAt: Date; sameIp: boolean }>(`SELECT id,"workspaceId","actorType","actorId","actorName",action,category,"targetType","targetId","targetLabel",metadata,
      host(ip) AS ip,"geoCity","geoCountry","geoRegion","createdAt",ip IS NOT DISTINCT FROM $2::inet AS "sameIp" FROM workspace_audit_events WHERE id=$1`, [receipt.id, payload.ip])).rows[0]
    if (!row) throw new AuditEventError('auditDeliveryReadbackMismatch')
    const { ip: _expectedIp, ...expected } = payload
    const { id: _id, createdAt, sameIp, ip: _actualIp, ...actual } = row
    if (!sameIp || createdAt.getTime() !== receipt.createdAt.getTime() || auditDigest(actual) !== auditDigest(expected)) throw new AuditEventError('auditDeliveryReadbackMismatch')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
/** The existing audit-maintenance tick delivers a bounded batch. No separate scheduler/state machine. */
export async function deliverWorkspaceAudits(database: Targets = { main: pool, workspace: workspacePool }, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid audit delivery limit')
  const source = await database.workspace.connect()
  let delivered = 0, failed = 0
  try {
    for (let index = 0; index < limit; index++) {
      await source.query('BEGIN')
      try {
        const receipt = (await source.query<Receipt>(`SELECT id,"workspaceId",payload,"createdAt" FROM workspace_audit_outbox WHERE "deliveredAt" IS NULL
          ORDER BY COALESCE("lastAttemptAt",'epoch'::timestamptz),"createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0]
        if (!receipt) { await source.query('COMMIT'); break }
        await source.query('UPDATE workspace_audit_outbox SET "lastAttemptAt"=now() WHERE id=$1', [receipt.id])
        try {
          const target = await database.main.connect()
          try { await writeAndReadBack(target, receipt) } finally { target.release() }
        } catch (error) {
          // Commit only the attempt time. The business change/receipt already committed;
          // the same stable event ID will retry after a main-store outage/restart.
          await source.query('COMMIT'); failed++
          console.error('[audit] delivery pending', { workspaceId: receipt.workspaceId, ...auditFailureSummary(error) })
          break
        }
        await source.query('UPDATE workspace_audit_outbox SET "deliveredAt"=now(),payload=NULL WHERE id=$1 AND "deliveredAt" IS NULL', [receipt.id])
        await source.query('COMMIT'); delivered++
      } catch (error) { await source.query('ROLLBACK'); throw error }
    }
  } finally { source.release() }
  return { delivered, failed }
}
