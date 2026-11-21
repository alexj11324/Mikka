import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from '@/lib/server-runtime/server'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { runPatchSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { maskFor, maskForRun } from '@/lib/secrets/runtime'
import { runChanged } from '@/lib/live/panels'
import { runListChanged } from '@/lib/live/lists'


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
async function handlePATCH(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  if (!await ownedRun(runId, caller.userId)) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  const parsed = runPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid patch.' }, { status: 400 })
  if (parsed.data.observedModel !== undefined && parsed.data.sessionId) {
    // A retried observation never sets session, state or worktree. The claim and
    // the established session must still belong to the reporting device.
    const model = (await maskForRun(runId, parsed.data.observedModel)).slice(0, 500)
    const changed = await db.update(agentRuns).set({ observedModel: model })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId),
        eq(agentRuns.deviceTokenId, caller.tokenId), eq(agentRuns.sessionId, parsed.data.sessionId),
        caller.scopeDeviceId ? eq(agentRuns.deviceId, caller.scopeDeviceId) : undefined,
        caller.scopeWorkspaceId ? eq(agentRuns.workspaceId, caller.scopeWorkspaceId) : undefined,
        inArray(agentRuns.status, ['running', 'waiting_input', 'finishing']),
        sql`${agentRuns.observedModel} IS DISTINCT FROM ${model}`))
      .returning({ id: agentRuns.id })
    if (changed.length) await runChanged(db, runId)
    return new Response(null, { status: 204 })
  }
  // 4e2 item 4: the error text is agent/harness output; mask it like run events.
  const patch = parsed.data.error !== undefined ? { ...parsed.data, error: await maskFor({ workspaceId: caller.scopeWorkspaceId, ownerId: caller.userId }, parsed.data.error) } : parsed.data
  if (!(LIVE_STATES as readonly string[]).includes(patch.state)) {
    // The end itself comes through `/complete`, which carries no error. A
    // failed run's reason arrives here, just before it: keep it (the first one
    // wins) without letting this patch move the run's state.
    if (patch.state === 'failed' && patch.error) {
      const changed = await db.update(agentRuns)
        .set({ error: patch.error, updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), isNull(agentRuns.error), inArray(agentRuns.status, [...LIVE_STATES, 'paused', 'failed'])))
        .returning({ id: agentRuns.id })
      if (changed.length) { await runListChanged(db, runId); await runChanged(db, runId) }
    }
    return new NextResponse(null, { status: 204 })
  }
  const changed = await db.update(agentRuns)
    .set({
      status: sql`CASE WHEN ${agentRuns.status}='paused' THEN 'paused' ELSE ${patch.state} END`,
      resumeStatus: sql`CASE WHEN ${agentRuns.status}='paused' THEN ${patch.state} ELSE NULL END`,
      ...(patch.sessionId !== undefined ? {
        sessionId: patch.sessionId,
        observedModel: sql`CASE WHEN ${agentRuns.sessionId} IS DISTINCT FROM ${patch.sessionId} THEN NULL ELSE ${agentRuns.observedModel} END`,
      } : {}),
      ...(patch.worktree !== undefined ? { worktreePath: patch.worktree } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updatedAt: new Date(),
    })
    // A run paused on its quota has ended on the daemon; a late patch does not move it.
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...LIVE_STATES, 'paused']), or(isNull(agentRuns.pauseReason), ne(agentRuns.pauseReason, 'quota_exhausted'))))
    .returning({ id: agentRuns.id })
  // Supervisor state transitions use this route. Its periodic device lease
  // heartbeat and streaming chunks have separate writers and send no list key.
  if (changed.length) { await runListChanged(db, runId); await runChanged(db, runId) }
  return new NextResponse(null, { status: 204 })
}

export const PATCH = withDeviceRoute(handlePATCH)
