import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import { RUN_CHECKPOINT_MAX_BYTES, runCheckpointSchema } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { LEASED_RUN_STATUSES } from '@/lib/run-retry'
import { CheckpointUnmaskable, maskCheckpoint } from '@/lib/secrets/checkpoint'
import { workspaceSecretMasker } from '@/lib/secrets/runtime'

export const dynamic = 'force-dynamic'

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
    .select({ id: agentRuns.id, userId: agentRuns.userId })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(devices.ownerId, caller.userId),
      ...(caller.scopeDeviceId ? [eq(agentRuns.deviceId, caller.scopeDeviceId)] : []),
      inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), gt(agentRuns.leaseExpiresAt, new Date()), isNull(agentRuns.stopRequestedAt)))
    .limit(1)
  // An ended run (or one taken over elsewhere) keeps the checkpoint it had.
  if (!run) return NextResponse.json({ error: 'Run is not running on this device.' }, { status: 409 })
  const parsed = runCheckpointSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid checkpoint.' }, { status: 400 })
  const patch = Buffer.from(parsed.data.patch, 'base64')
  if (patch.length > RUN_CHECKPOINT_MAX_BYTES) return NextResponse.json({ error: 'Checkpoint too large.' }, { status: 413 })
  // 4e2 item 4: the patch is the agent's work tree diff; secrets written to files are masked.
  const mask = await workspaceSecretMasker(caller.scopeWorkspaceId)
  let masked: ReturnType<typeof maskCheckpoint<number>>
  try { masked = maskCheckpoint({ patch, files: parsed.data.files }, mask) } catch (error) {
    if (error instanceof CheckpointUnmaskable) return NextResponse.json({ error: 'Checkpoint could not be read.' }, { status: 422 })
    throw error
  }
  // Keep the authority row locked through the write. A STOP, takeover or
  // expired lease during masking cannot overwrite the last admitted snapshot.
  const saved = await pool.query(`WITH admitted AS (
    SELECT r.id,r."userId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND d."ownerId"=$2
      AND ($3::uuid IS NULL OR r."deviceId"=$3) AND r.status=ANY($4::text[])
      AND r."leaseExpiresAt">clock_timestamp() AND r."stopRequestedAt" IS NULL
    FOR SHARE OF r,d
  ) INSERT INTO run_checkpoints ("runId","userId","baseCommit",patch,files,"takenAt","updatedAt","unavailableReason")
    SELECT id,"userId",$5,$6,$7,clock_timestamp(),clock_timestamp(),$8 FROM admitted
    ON CONFLICT ("runId") DO UPDATE SET "baseCommit"=EXCLUDED."baseCommit",patch=EXCLUDED.patch,
      files=EXCLUDED.files,"takenAt"=EXCLUDED."takenAt","updatedAt"=EXCLUDED."updatedAt","unavailableReason"=EXCLUDED."unavailableReason"
    RETURNING "runId"`, [run.id, caller.userId, caller.scopeDeviceId ?? null, [...LEASED_RUN_STATUSES], parsed.data.baseCommit, masked.patch, masked.files, parsed.data.unavailableReason ?? null])
  if (!saved.rowCount) return NextResponse.json({ error: 'Run is not running on this device.' }, { status: 409 })
  return new NextResponse(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
