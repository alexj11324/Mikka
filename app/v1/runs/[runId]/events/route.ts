import { withDeviceAuthorization } from '@/lib/device-link'
import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { runEventBatchSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices, runChunks } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** A run the caller's token may report on: it belongs to one of their devices. */
async function ownedRun(runId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(devices.ownerId, userId)))
    .limit(1)
  return Boolean(row)
}

/**
 * `POST /v1/runs/:runId/events`: a batch of the run's UI message chunks.
 * `fromSeq` makes a re-sent batch land once, so a lost response costs nothing.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  if (!await ownedRun(runId, caller.userId)) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  const parsed = runEventBatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid event batch.' }, { status: 400 })
  await db.insert(runChunks)
    .values(parsed.data.chunks.map((chunk, index) => ({
      id: crypto.randomUUID(), runId, seq: parsed.data.fromSeq + index,
      chunk: chunk as Record<string, unknown>,
    })))
    .onConflictDoNothing()
  await db.update(agentRuns)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'preparing')))
  const [tail] = await db
    .select({ seq: sql<number | null>`max(${runChunks.seq})` })
    .from(runChunks)
    .where(eq(runChunks.runId, runId))
  return NextResponse.json({ offset: String(tail?.seq ?? 0) })
}

export const POST = withDeviceAuthorization(handlePOST)
