import 'server-only'
import { z } from 'zod'
import { WorkspaceReviewError, reviewBatchReceipt } from '@mikka/protocol/coding-workspace-review'
import { withReviewTransaction, type ReviewActor } from './authority'
import type { DiffDependencies } from './service'
import { batchReceipt, readReviewBatch, type ReviewBatchRow } from './batch-store'
import { readDiffSnapshot } from './store'

const cursorSchema = z.strictObject({ snapshotId: z.uuid(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(), createdAt: z.iso.datetime(), id: z.uuid() })
export const reviewDeliveryQuery = z.strictObject({ batchId: z.uuid().optional(), cursor: z.string().max(1024).optional() })
  .refine(value => !(value.batchId && value.cursor))

/** Historical delivery facts remain visible with local Task authority even
 * when a GitHub token is gone. No frozen body or provider permission is exposed. */
export async function readReviewDeliveries(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  snapshotId: string, raw: z.infer<typeof reviewDeliveryQuery>, signal?: AbortSignal) {
  const input = reviewDeliveryQuery.parse(raw)
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, scope) => {
    const snapshot = await readDiffSnapshot(tx, scope, snapshotId)
    if (input.batchId) {
      const row = await readReviewBatch(tx, actor, scope, input.batchId)
      if (row.snapshotId !== snapshotId) throw new WorkspaceReviewError('workspace_review_unavailable')
      return { batch: await batchReceipt(tx, scope, row) }
    }
    const { rows: [board] } = await tx.query<{ revision: number }>('SELECT revision FROM coding_workspace_review_boards WHERE id=$1 FOR SHARE', [scope.boardId])
    if (!board) throw new WorkspaceReviewError('workspace_review_unavailable')
    let after: z.infer<typeof cursorSchema> | undefined
    if (input.cursor) {
      try { after = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))) }
      // error-cause: a malformed client cursor can contain private arbitrary input.
      catch { throw new WorkspaceReviewError('workspace_review_conflict') }
      if (after.snapshotId !== snapshot.id || after.sourceVersion !== snapshot.revision.version || after.revision !== board.revision)
        throw new WorkspaceReviewError('workspace_review_conflict')
    }
    const { rows } = await tx.query<ReviewBatchRow & { createdAt: Date }>(`SELECT * FROM coding_workspace_review_batches
      WHERE "boardId"=$1 AND "userId"=$2 AND "snapshotId"=$3
        AND ($4::timestamptz IS NULL OR ("createdAt",id)<($4,$5::uuid))
      ORDER BY "createdAt" DESC,id DESC LIMIT 51`, [scope.boardId, actor.userId, snapshotId, after?.createdAt ?? null, after?.id ?? null])
    const page = rows.slice(0, 50), last = page.at(-1)
    return { batches: page.map(row => reviewBatchReceipt.parse({ batchId: row.id, destination: row.destination, state: row.state,
      sourceVersion: snapshot.revision.version, revision: board.revision, delivery: row.receipt?.delivery ?? null,
      ...(row.receipt?.reason ? { reason: row.receipt.reason } : {}) })),
    nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify({ snapshotId: snapshot.id,
      sourceVersion: snapshot.revision.version, revision: board.revision, createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null }
  }, { signal })
}
