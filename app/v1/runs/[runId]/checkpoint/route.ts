import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { RUN_CHECKPOINT_MAX_BYTES, runCheckpointReceiptSchema, runCheckpointSchema } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { LEASED_RUN_STATUSES } from '@/lib/run-retry'
import { CheckpointUnmaskable, maskCheckpoint } from '@/lib/secrets/checkpoint'
import { runSecretMasker, runWorkspaceId, secretMaskerFor } from '@/lib/secrets/runtime'
import { workspacePool } from '@/lib/workspace-db'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { workspaceJSON } from '@/lib/coding-workspace/http'
import { resolveRunWorktree } from '@/lib/coding-workspace/identity'
import { withReviewTransaction, type ReviewActor } from '@/lib/coding-workspace/diff/authority'
import { prepareCheckpointReview, retainCheckpointReview } from '@/lib/coding-workspace/diff/checkpoint'
import { observeCommitEffects } from '@/lib/db/commit-effects'
import { runChanged } from '@/lib/live/panels'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * `POST /v1/runs/:runId/checkpoint`: the run's work in progress, from the
 * daemon of the device it runs on. Only the latest one is kept; another
 * machine that takes the run over starts from it.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const [run] = await db
    .select({ id: agentRuns.id, userId: agentRuns.userId, deviceId: agentRuns.deviceId, repoId: agentRuns.deviceRepoId,
      tokenId: agentRuns.deviceTokenId, worktreePath: agentRuns.worktreePath })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(devices.ownerId, caller.userId),
      or(isNull(agentRuns.deviceTokenId), eq(agentRuns.deviceTokenId, caller.tokenId)),
      ...(caller.scopeDeviceId ? [eq(agentRuns.deviceId, caller.scopeDeviceId)] : []),
      inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), gt(agentRuns.leaseExpiresAt, new Date()), isNull(agentRuns.stopRequestedAt)))
    .limit(1)
  // An ended run (or one taken over elsewhere) keeps the checkpoint it had.
  if (!run) return NextResponse.json({ error: 'Run is not running on this device.' }, { status: 409 })
  let body: unknown
  try { body = await workspaceJSON(request, 20 * 1024 * 1024) }
  catch (error) {
    if (!(error instanceof CodingWorkspaceError)) throw error
    return NextResponse.json({ error: error.code === 'workspace_limit_exceeded' ? 'Checkpoint too large.' : 'Invalid checkpoint.' },
      { status: error.code === 'workspace_limit_exceeded' ? 413 : 400 })
  }
  const parsed = runCheckpointSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid checkpoint.' }, { status: 400 })
  const patch = Buffer.from(parsed.data.patch, 'base64')
  if (patch.length > RUN_CHECKPOINT_MAX_BYTES) return NextResponse.json({ error: 'Checkpoint too large.' }, { status: 413 })
  // 4e2 item 4: the patch is the agent's work tree diff; secrets written to files are masked.
  const mask = await runSecretMasker(runId)
  let masked: ReturnType<typeof maskCheckpoint<number>>
  try { masked = maskCheckpoint({ patch, files: parsed.data.files }, mask) } catch (error) {
    if (error instanceof CheckpointUnmaskable) return NextResponse.json({ error: 'Checkpoint could not be read.' }, { status: 422 })
    throw error
  }
  // Keep the authority row locked through the write. A STOP, takeover or
  // expired lease during masking cannot overwrite the last admitted snapshot.
  const save = (client: PoolClient, protectedPatch: ReturnType<typeof maskCheckpoint<number>>) => client.query<{ runId: string; takenAt: Date }>(`WITH admitted AS (
    SELECT r.id,r."userId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND d."ownerId"=$2
      AND (r."deviceTokenId" IS NULL OR r."deviceTokenId"=$9)
      AND ($3::uuid IS NULL OR r."deviceId"=$3) AND r.status=ANY($4::text[])
      AND r."leaseExpiresAt">clock_timestamp() AND r."stopRequestedAt" IS NULL
    FOR SHARE OF r,d
  ) INSERT INTO run_checkpoints ("runId","userId","baseCommit",patch,files,"takenAt","updatedAt","unavailableReason")
    SELECT id,"userId",$5,$6,$7,clock_timestamp(),clock_timestamp(),$8 FROM admitted
    ON CONFLICT ("runId") DO UPDATE SET "baseCommit"=EXCLUDED."baseCommit",patch=EXCLUDED.patch,
      files=EXCLUDED.files,"takenAt"=EXCLUDED."takenAt","updatedAt"=EXCLUDED."updatedAt","unavailableReason"=EXCLUDED."unavailableReason"
    RETURNING "runId","takenAt"`, [run.id, caller.userId, caller.scopeDeviceId ?? null, [...LEASED_RUN_STATUSES], parsed.data.baseCommit,
    protectedPatch.patch, protectedPatch.files, parsed.data.unavailableReason ?? null, caller.tokenId])
  try {
    const workspaceId = run.tokenId && run.repoId && run.worktreePath ? await runWorkspaceId(runId) : null
    let live: Awaited<ReturnType<typeof resolveRunWorktree>> | null = null
    if (workspaceId && run.repoId) {
      try { live = await resolveRunWorktree(pool, workspacePool, { userId: caller.userId, workspaceId }, runId, run.repoId) }
      catch (error) { if (!(error instanceof CodingWorkspaceError)) throw error }
    }
    let saved: { runId: string; takenAt: Date } | undefined
    if (live && workspaceId && run.repoId && run.deviceId) {
      const actor: ReviewActor = { userId: caller.userId, workspaceId, credential: { kind: 'device', id: caller.tokenId, deviceId: run.deviceId } }
      const prepared = prepareCheckpointReview(parsed.data, run.repoId, mask)
      saved = await withReviewTransaction(pool, workspacePool, actor, runId, run.repoId, async (client, scope) => {
        const freshMask = await secretMaskerFor({ workspaceId: scope.identity.workspaceId, ownerId: scope.identity.ownerId })
        const current = freshMask.sourcePolicy === mask.sourcePolicy ? masked : maskCheckpoint({ patch, files: parsed.data.files }, freshMask)
        const { rows: [receipt] } = await save(client, current)
        if (!receipt) throw new CodingWorkspaceError('workspace_machine_unavailable')
        await retainCheckpointReview(client, scope, prepared, receipt.takenAt, freshMask)
        await runChanged(client, runId)
        return receipt
      }, { live: live.identity, signal: request.signal })
    } else {
      // Old daemons/runs can still establish a recovery safe point. They do
      // not create guessed repository bindings or certify old source proofs.
      const client = await pool.connect(); observeCommitEffects(client)
      try {
        await client.query('BEGIN')
        const freshMask = await runSecretMasker(runId)
        const current = freshMask.sourcePolicy === mask.sourcePolicy ? masked : maskCheckpoint({ patch, files: parsed.data.files }, freshMask)
        saved = (await save(client, current)).rows[0]
        if (saved) {
          await client.query(`UPDATE coding_workspace_checkpoint_reviews SET "snapshotId"=NULL,"baseSha"=$3,"headSha"=NULL,"treeSha"=NULL,
            reason=$4,"capturedAt"=$5 WHERE "runId"=$1 AND "ownerId"=$2`,
          [runId, caller.userId, parsed.data.baseCommit, parsed.data.unavailableReason ?? 'missing_evidence', saved.takenAt])
          await runChanged(client, runId)
        }
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    if (!saved) return NextResponse.json({ error: 'Run is not running on this device.' }, { status: 409 })
    return NextResponse.json(runCheckpointReceiptSchema.parse({ runId: saved.runId, takenAt: saved.takenAt.toISOString() }))
  } catch (error) {
    if (error instanceof CheckpointUnmaskable) return NextResponse.json({ error: 'Checkpoint could not be read.' }, { status: 422 })
    if (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError)
      return NextResponse.json({ error: 'Run is not running on this device.' }, { status: 409 })
    throw error
  }
}

export const POST = withDeviceRoute(handlePOST)
