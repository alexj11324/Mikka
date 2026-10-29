import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { runEventBatchSchema } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, devices, runChunks } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { computerEventsMatch } from '@/lib/computer/events'
import { freshChunks, nextReply } from '@/lib/thread-groups'

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Keeps `agent_runs.lastReply` on the opening of the agent's latest text part
 * (lib/thread-groups.ts `nextReply`), in the same transaction as the insert.
 * The row is locked so two batches of one run cannot interleave.
 */
async function recordLastReply(tx: Tx, runId: string, chunks: Record<string, unknown>[]) {
  if (!chunks.some(chunk => chunk.type === 'text-delta')) return
  const [stored] = await tx.select({ lastReply: agentRuns.lastReply, lastReplyPart: agentRuns.lastReplyPart }).from(agentRuns)
    .where(eq(agentRuns.id, runId)).for('no key update')
  if (!stored) return
  const next = nextReply(stored, chunks)
  if (!next) return
  await tx.update(agentRuns).set({ ...next, lastReplyAt: new Date() }).where(eq(agentRuns.id, runId))
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
  await db.transaction(async tx => {
    const inserted = await tx.insert(runChunks)
      .values(parsed.data.chunks.map((chunk, index) => ({
        id: crypto.randomUUID(), runId, seq: parsed.data.fromSeq + index,
        chunk: chunk as Record<string, unknown>,
      })))
      .onConflictDoNothing()
      .returning({ seq: runChunks.seq })
    // Only chunks stored now count, so a re-sent batch never appends its text twice.
    await recordLastReply(tx, runId, freshChunks(parsed.data.chunks as Record<string, unknown>[], parsed.data.fromSeq, inserted.map(row => row.seq)))
  })
  await db.update(agentRuns)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'preparing')))
  const [tail] = await db
    .select({ seq: sql<number | null>`max(${runChunks.seq})` })
    .from(runChunks)
    .where(eq(runChunks.runId, runId))
  return NextResponse.json({ offset: String(tail?.seq ?? 0) })
}
