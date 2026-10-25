import { z } from 'zod'
import { OperationError, type OperationAuthorize } from './ledger'

const actorSchema = z.object({ userId: z.string().min(1), sessionId: z.string().min(1) }).strict()
/** actor MUST come from server-side Better Auth getSession, never request JSON.
 * Compose with the existing domain's authorization; this does not grant approval.
 * Lock order: ledger -> session -> domain approval. Recheck expiry after lock wait.
 */
export function withOperationSession(actor: z.infer<typeof actorSchema>, authorizeIntent: OperationAuthorize): OperationAuthorize {
  const human = actorSchema.parse(actor)
  if (typeof authorizeIntent !== 'function') throw new OperationError('operationAuthorizationRequired')
  return async (tx, binding, runId, phase) => {
    if (binding.ownerId !== human.userId) throw new OperationError('operationSessionUnavailable')
    const { rows } = await tx.query('SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE', [human.sessionId, human.userId])
    if (!rows.length) throw new OperationError('operationSessionUnavailable')
    const current = await tx.query('SELECT id FROM "session" WHERE id=$1 AND "expiresAt">clock_timestamp()', [human.sessionId])
    if (!current.rows.length) throw new OperationError('operationSessionUnavailable')
    await authorizeIntent(tx, binding, runId, phase)
    // Domain locks may have waited past session expiry while our SHARE lock held.
    const final = await tx.query('SELECT id FROM "session" WHERE id=$1 AND "expiresAt">clock_timestamp()', [human.sessionId])
    if (!final.rows.length) throw new OperationError('operationSessionUnavailable')
  }
}
