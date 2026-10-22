import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { runPatchSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** States the daemon may report mid-run; the end comes through `/complete`. */
const LIVE_STATES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

async function ownedRun(runId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(devices.ownerId, userId)))
    .limit(1)
  return Boolean(row)
}

/** `PATCH /v1/runs/:runId`: the run's live state, session and worktree. */
export async function PATCH(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  if (!await ownedRun(runId, caller.userId)) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  const parsed = runPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid patch.' }, { status: 400 })
  const patch = parsed.data
  if (!(LIVE_STATES as readonly string[]).includes(patch.state)) return new NextResponse(null, { status: 204 })
  await db.update(agentRuns)
    .set({
      status: patch.state as (typeof LIVE_STATES)[number],
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.worktree !== undefined ? { worktreePath: patch.worktree } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId))
  return new NextResponse(null, { status: 204 })
}
