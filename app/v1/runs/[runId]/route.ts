import { NextResponse } from 'next/server'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { runPatchSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { maskForWorkspace } from '@/lib/secrets/runtime'

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
  // 4e2 item 4: the error text is agent/harness output; mask it like run events.
  const patch = parsed.data.error !== undefined ? { ...parsed.data, error: await maskForWorkspace(caller.scopeWorkspaceId, parsed.data.error) } : parsed.data
  if (!(LIVE_STATES as readonly string[]).includes(patch.state)) return new NextResponse(null, { status: 204 })
  await db.update(agentRuns)
    .set({
      status: sql`CASE WHEN ${agentRuns.status}='paused' THEN 'paused' ELSE ${patch.state} END`,
      resumeStatus: sql`CASE WHEN ${agentRuns.status}='paused' THEN ${patch.state} ELSE NULL END`,
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.worktree !== undefined ? { worktreePath: patch.worktree } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...LIVE_STATES, 'paused'])))
  return new NextResponse(null, { status: 204 })
}
