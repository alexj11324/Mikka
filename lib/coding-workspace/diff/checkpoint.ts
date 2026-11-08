import 'server-only'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import type { RunCheckpoint } from '@mikka/protocol/device'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { checkpointReviewEvidence, CHECKPOINT_REVIEW_MAX_PROOF_BYTES, WORKSPACE_DIFF_MAX_BLOB_BYTES, WorkspaceReviewError,
  type DiffFilePatch, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'
import type { ReviewScope } from './authority'
import { buildDiffFilePatch, diffFileVersion, gitBlobHash } from './patch'
import { manifestRevision, retainDiffSnapshot } from './store'

type Reason = 'missing_evidence' | 'too_large' | 'unsupported' | 'version_changed'
export type PreparedCheckpointReview = {
  baseSha: string; headSha: string | null; treeSha: string | null; reason: Reason | null; maskPolicy?: string;
  input?: Parameters<typeof retainDiffSnapshot>[2];
}

/** Full proofs remain in this call's memory. A valid recovery checkpoint can
 * still be acknowledged when its independent review envelope is unusable. */
export function prepareCheckpointReview(checkpoint: RunCheckpoint, repoId: string, mask: Masker): PreparedCheckpointReview {
  const result: PreparedCheckpointReview = { baseSha: checkpoint.baseCommit, headSha: null, treeSha: null,
    reason: checkpoint.unavailableReason === 'too_large' ? 'too_large' : 'missing_evidence', maskPolicy: mask.sourcePolicy }
  const parsed = checkpointReviewEvidence.safeParse(checkpoint.review)
  if (!parsed.success || parsed.data.repoId !== repoId || parsed.data.revision.baseSha !== checkpoint.baseCommit) return result
  const proof = parsed.data
  result.headSha = proof.revision.headSha; result.treeSha = proof.revision.treeSha
  if (checkpoint.unavailableReason) return result
  if (proof.reason) return { ...result, reason: proof.reason }
  if (!proof.revision.headSha || !mask.sourcePolicy || new Set(proof.files.map(file => file.path)).size !== proof.files.length) return result
  if (Buffer.byteLength(JSON.stringify(proof.files)) > 1536 * 1024) return { ...result, reason: 'too_large' }
  const revision = manifestRevision('checkpoint', proof.revision.baseSha, proof.revision.headSha, proof.revision.treeSha, proof.files)
  if (!isDeepStrictEqual(revision, proof.revision) || proof.files.some(file => file.github !== undefined || file.rawBlob || file.rawSize !== undefined || file.workingVersion
    || file.fileVersion !== diffFileVersion(repoId, revision, file)) || !isDeepStrictEqual(maskDeep(proof.files, mask), proof.files)) return result
  const regular = (mode: string | null) => mode === null || mode === '100644' || mode === '100755'
  const eligible = proof.files.filter(file => regular(file.oldMode) && regular(file.newMode)
    && [file.oldSize, file.newSize].every(size => size === null || (size !== undefined && size <= WORKSPACE_DIFF_MAX_BLOB_BYTES)))
  const provenFiles = new Set(eligible)
  const wanted = new Set(eligible.flatMap(file => [file.oldBlob, file.newBlob].filter((sha): sha is string => sha !== null)))
  if (proof.blobs.length !== wanted.size || new Set(proof.blobs.map(blob => blob.sha)).size !== proof.blobs.length) return result
  let bytes = 0
  const objects = new Map<string, Buffer>()
  for (const blob of proof.blobs) {
    const value = Buffer.from(blob.base64, 'base64')
    bytes += value.length
    if (bytes > CHECKPOINT_REVIEW_MAX_PROOF_BYTES) return { ...result, reason: 'too_large' }
    if (!wanted.has(blob.sha) || blob.clean || blob.rawSha || value.toString('base64') !== blob.base64
      || value.length > WORKSPACE_DIFF_MAX_BLOB_BYTES || gitBlobHash(value, blob.sha) !== blob.sha) return result
    objects.set(blob.sha, value)
  }
  const patches = new Map<string, DiffFilePatch>(), snapshotId = randomUUID(), deadline = Date.now() + 1500
  try {
    for (const file of proof.files) {
      if (Date.now() >= deadline) return { ...result, reason: 'too_large' }
      if (provenFiles.has(file)) {
        if ((file.oldBlob && objects.get(file.oldBlob)?.length !== file.oldSize)
          || (file.newBlob && objects.get(file.newBlob)?.length !== file.newSize)) return result
        patches.set(file.path, buildDiffFilePatch({ snapshotId, sourceVersion: revision.version, file,
          before: file.oldBlob ? objects.get(file.oldBlob)! : null, after: file.newBlob ? objects.get(file.newBlob)! : null }, mask))
      } else patches.set(file.path, { snapshotId, sourceVersion: revision.version, file,
        format: regular(file.oldMode) && regular(file.newMode) ? 'too_large' : 'unavailable', patch: null, hunks: [] })
    }
  } catch (error) {
    if (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) return result
    throw error
  }
  return { ...result, reason: null, input: { revision, files: proof.files, patches } }
}

/** Called after the admitted recovery INSERT, in that same APP transaction.
 * Expected review limits roll back only this sidecar; ACK still follows both
 * the recovery record and an honest latest-review pointer being committed. */
export async function retainCheckpointReview(client: PoolClient, scope: ReviewScope, prepared: PreparedCheckpointReview,
  capturedAt: Date, mask: Masker): Promise<void> {
  let reason = prepared.reason, snapshot: DiffSnapshot | undefined
  if (!reason && prepared.maskPolicy !== mask.sourcePolicy) reason = 'missing_evidence'
  if (!reason && prepared.input) {
    await client.query('SAVEPOINT checkpoint_review')
    try {
      snapshot = await retainDiffSnapshot(client, scope, { ...prepared.input, observedAt: capturedAt.toISOString() }, mask)
      // Content-addressed deduplication can find an older immutable artifact.
      // Its partial patches cannot be certified by a new secret policy merely
      // because a new observation has the same source version.
      if ((await client.query(`SELECT 1 FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1
        AND (patch IS NULL OR "maskPolicy" IS DISTINCT FROM $2) LIMIT 1`, [snapshot.id, mask.sourcePolicy])).rowCount)
        throw new CodingWorkspaceError('workspace_path_unavailable')
      await client.query('RELEASE SAVEPOINT checkpoint_review')
    } catch (error) {
      if (!(error instanceof CodingWorkspaceError) && !(error instanceof WorkspaceReviewError)) throw error
      await client.query('ROLLBACK TO SAVEPOINT checkpoint_review'); await client.query('RELEASE SAVEPOINT checkpoint_review')
      snapshot = undefined
      reason = error.code === 'workspace_limit_exceeded' ? 'too_large' : 'missing_evidence'
    }
  }
  await client.query(`INSERT INTO coding_workspace_checkpoint_reviews
    ("runId","repoId","ownerId","workspaceId","snapshotId","baseSha","headSha","treeSha",reason,"capturedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT ("runId") DO UPDATE SET
      "repoId"=EXCLUDED."repoId","ownerId"=EXCLUDED."ownerId","workspaceId"=EXCLUDED."workspaceId",
      "snapshotId"=EXCLUDED."snapshotId","baseSha"=EXCLUDED."baseSha","headSha"=EXCLUDED."headSha",
      "treeSha"=EXCLUDED."treeSha",reason=EXCLUDED.reason,"capturedAt"=EXCLUDED."capturedAt"`,
  [scope.identity.runId, scope.identity.repoId, scope.identity.ownerId, scope.identity.workspaceId, snapshot?.id ?? null,
    prepared.baseSha, prepared.headSha, prepared.treeSha, snapshot ? null : reason ?? 'missing_evidence', capturedAt])
}
