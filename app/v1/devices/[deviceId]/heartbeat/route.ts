import { authorizePolicyWorker } from '@/lib/policy/runtime'
import { after, NextResponse } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { deviceHeartbeatSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { reclaimLostRuns, renewRunLeases } from '@/lib/run-leases'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { skillAssignments } from '@/lib/self-improvement/server'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. The answer carries the renewed lease of each run
 * the device reports that is still claimed by it, and the runs it no longer
 * holds, which the daemon stops.
 * Afterwards, runs the owner lost on another device are queued again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = deviceHeartbeatSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
  await db.update(devices).set({ harnesses: parsed.data.harnesses, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(devices.id, deviceId))
  const reported = parsed.data.runs.map(run => run.runId)
  const allowed: string[] = []
  const denied: string[] = []
  const runs = reported.length ? await db.select({ id: agentRuns.id, issueId: agentRuns.issueId }).from(agentRuns)
    .where(and(eq(agentRuns.userId, caller.userId), eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, reported))) : []
  for (const run of runs) {
    try { await authorizePolicyWorker(caller.userId, run.id, run.issueId ?? undefined); allowed.push(run.id) }
    catch { denied.push(run.id) }
  }
  denied.push(...reported.filter(id => !runs.some(run => run.id === id)))
  const selected=await skillAssignments.renewHeartbeat(caller.userId,deviceId,allowed,request.headers.get(SKILL_ARTIFACT_HEADER)==='1')
  const result = await renewRunLeases(deviceId, selected.legacy)
  result.leases={...result.leases,...selected.leases}
  result.revoked=[...new Set([...(result.revoked??[]),...selected.revoked,...denied])]
  after(() => reclaimLostRuns(caller.userId).catch((error: unknown) => console.error('Could not reclaim lost runs', error instanceof Error ? error.message : error)))
  return NextResponse.json(result)
}
