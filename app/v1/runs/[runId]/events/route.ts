import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { runEventBatchSchema } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, devices, runChunks } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { computerEventsMatch } from '@/lib/computer/events'
import { workspaceSecretMasker } from '@/lib/secrets/runtime'
import { persistRunEventBatch } from '@/lib/secrets/run-events'

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
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  if (!await ownedRun(runId, caller.userId)) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  const parsed = runEventBatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid event batch.' }, { status: 400 })
  if (parsed.data.chunks.some(chunk => chunk.type === 'data-computer')) {
    const binding = caller.scopeDeviceId && caller.scopeWorkspaceId
      ? (await pool.query(`SELECT b."botId" FROM computer_run_bindings b JOIN agent_runs r ON r.id=b."runId" AND r."userId"=b."ownerId"
        WHERE b."runId"=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND r."deviceId"=$4`, [runId, caller.userId, caller.scopeWorkspaceId, caller.scopeDeviceId])).rows[0]
      : undefined
    if (!computerEventsMatch(parsed.data.chunks, runId, binding?.botId ?? null)) return NextResponse.json({ error: 'Invalid computer event.' }, { status: 400 })
  }
  // 4e2 ②: chunks from a cloud worker (workspace-scoped token) are masked before they are stored.
  // Identity when MIKKA_BYO_E2B_KEY is off or the workspace has no secret of 8+ characters.
  const mask = await workspaceSecretMasker(caller.scopeWorkspaceId)
  await persistRunEventBatch(runId, parsed.data.fromSeq, parsed.data.chunks, mask)
  await db.update(agentRuns)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'preparing')))
  const [tail] = await db
    .select({ seq: sql<number | null>`max(${runChunks.seq})` })
    .from(runChunks)
    .where(eq(runChunks.runId, runId))
  return NextResponse.json({ offset: String(tail?.seq ?? 0) })
}
