import type { Pool } from 'pg'
import { z } from 'zod'
import { writeTransaction, type WriteRequestContext } from './write-transaction'
import { projectApprovedWriteView, type ApprovedWriteView, type StoredWriteProposal } from './approved-writes'
import { OperationError, type OperationRecord } from './ledger'
import { requireOperationSession } from './session-authorization'
import { WRITE_ACTIONS, type WriteActionName } from './write-contract'
import { snapshotDigest } from './write-target'

const timestamp = z.iso.datetime({ precision: 6 })
const cursorSchema = z.object({ v: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/), asOf: timestamp, after: z.object({ at: timestamp, id: z.uuid() }).strict() }).strict()
export const discoveryInput = z.object({ cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().min(1).max(50).default(20), unresolvedOnly: z.boolean().default(false) }).strict()
export interface WriteAttention { id: string; action: WriteActionName; createdAt: string; status: 'attention'; error: 'operationBindingConflict' | 'operationIntentAmbiguous' }
export interface WritePage { items: (ApprovedWriteView | WriteAttention)[]; nextCursor: string | null; asOf: string }
interface DiscoveryRow extends StoredWriteProposal { cursorCreatedAt: string; aliasCount: string; execution: (OperationRecord & { invokedAt: string | null }) | null }
const formatTime = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`

export function createApprovedWriteDiscovery(pool: Pool) {
  return {
    async list(actor: { userId: string; sessionId: string }, raw: unknown, context: WriteRequestContext = {}): Promise<WritePage> {
      const input = discoveryInput.safeParse(raw)
      if (!input.success) throw new OperationError('invalidWriteCursor')
      const binding = snapshotDigest(input.data.unresolvedOnly ? [actor.userId, actor.sessionId, 'unresolved'] : [actor.userId, actor.sessionId])
      let cursor: z.infer<typeof cursorSchema> | null = null
      if (input.data.cursor) {
        try {
          if (!/^[A-Za-z0-9_-]+$/.test(input.data.cursor)) throw Error('encoding')
          cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.data.cursor, 'base64url').toString('utf8')))
          if (cursor.binding !== binding || cursor.after.at > cursor.asOf) throw Error('binding')
        } catch { throw new OperationError('invalidWriteCursor') }
      }
      return writeTransaction(pool, async tx => {
        // One consistent row/ledger snapshot per page; no proposal/ledger locks,
        // writes, providers, or execution capabilities. Session lock prevents an
        // expired/revoked session from being mistaken for cursor authority.
        await requireOperationSession(tx, actor, actor.userId)
        const now = timestamp.parse((await tx.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${formatTime}) AS now`)).rows[0].now)
        const asOf = cursor?.asOf ?? now
        if (asOf > now) throw new OperationError('invalidWriteCursor')
        const { rows } = await tx.query<DiscoveryRow>(`SELECT p.*, to_char(p."createdAt" AT TIME ZONE 'UTC', ${formatTime}) AS "cursorCreatedAt",
          CASE WHEN l."operationId" IS NULL THEN NULL ELSE row_to_json(l) END AS execution,
          (SELECT count(*) FROM pending_actions a WHERE a."userId"=p."userId" AND lower(a."intentKey")=lower(p."intentKey")) AS "aliasCount"
          FROM pending_actions p LEFT JOIN operation_ledger l ON l."operationId"=p.id AND l."ownerId"=p."userId" AND l."workspaceId"='personal:'||p."userId"
          WHERE p."userId"=$1 AND p.action=ANY($2::text[]) AND p."createdAt" <= $3::timestamptz
          AND ($7::boolean=false OR (p.status IN ('pending','running') AND (l.status IS NULL OR l.status <> 'succeeded')) OR (l."invokedAt" IS NOT NULL AND l.status <> 'succeeded'))
          AND ($4::timestamptz IS NULL OR (p."createdAt",p.id) < ($4::timestamptz,$5::uuid))
          ORDER BY p."createdAt" DESC,p.id DESC LIMIT $6`, [actor.userId, WRITE_ACTIONS, asOf, cursor?.after.at ?? null, cursor?.after.id ?? null, input.data.limit + 1, input.data.unresolvedOnly])
        const page = rows.slice(0, input.data.limit), seen = new Set<string>()
        const items = page.map(row => {
          if (row.userId !== actor.userId || !WRITE_ACTIONS.includes(row.action as WriteActionName) || seen.has(row.id)) throw new OperationError('operationBindingConflict')
          seen.add(row.id)
          try {
            if (Number(row.aliasCount) !== 1) throw new OperationError('operationIntentAmbiguous')
            return projectApprovedWriteView(row, row.execution)
          } catch (error) {
            if (!(error instanceof OperationError) || !['operationBindingConflict', 'operationIntentAmbiguous'].includes(error.message)) throw error
            // A legacy/bad proposal cannot poison discovery or become approvable.
            return { id: row.id, action: row.action as WriteActionName, createdAt: new Date(row.createdAt).toISOString(), status: 'attention' as const, error: error.message as WriteAttention['error'] }
          }
        })
        const last = page.at(-1)
        const nextCursor = rows.length > input.data.limit && last ? Buffer.from(JSON.stringify({ v: 1, binding, asOf, after: { at: timestamp.parse(last.cursorCreatedAt), id: last.id } })).toString('base64url') : null
        await requireOperationSession(tx, actor, actor.userId)
        return { items, nextCursor, asOf }
      }, { signal: context.signal, begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ' })
    },
  }
}
