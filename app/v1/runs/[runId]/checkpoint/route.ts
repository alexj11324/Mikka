import { NextResponse } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { RUN_CHECKPOINT_MAX_BYTES, runCheckpointSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices, runCheckpoints } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { LEASED_RUN_STATUSES } from '@/lib/run-retry'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/runs/:runId/checkpoint`: the run's work in progress, from the
 * daemon of the device it runs on. Only the latest one is kept; another
 * machine that takes the run over starts from it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const [run] = await db
    .select({ id: agentRuns.id, userId: agentRuns.userId })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(devices.ownerId, caller.userId), inArray(agentRuns.status, [...LEASED_RUN_STATUSES])))
    .limit(1)
  // An ended run (or one taken over elsewhere) keeps the checkpoint it had.
  if (!run) return NextResponse.json({ error: 'Run is not running on this device.' }, { status: 409 })
  const parsed = runCheckpointSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid checkpoint.' }, { status: 400 })
  const patch = Buffer.from(parsed.data.patch, 'base64')
  if (patch.length > RUN_CHECKPOINT_MAX_BYTES) return NextResponse.json({ error: 'Checkpoint too large.' }, { status: 413 })
  const values = { baseCommit: parsed.data.baseCommit, patch, files: parsed.data.files, takenAt: new Date(parsed.data.takenAt), updatedAt: new Date() }
  await db.insert(runCheckpoints).values({ runId: run.id, userId: run.userId, ...values })
    .onConflictDoUpdate({ target: runCheckpoints.runId, set: values })
  return new NextResponse(null, { status: 204 })
}
