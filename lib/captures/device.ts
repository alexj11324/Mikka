import 'server-only'
import { NextResponse } from 'next/server'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import type { CaptureError, CaptureOwner } from './store'

// The daemon's side of captures: it signs in with its device credential, and
// the run must be live on one of the caller's own devices. The capture is
// bound to that run, its issue and its Bot; nothing the daemon sends can move
// it to another.

const LIVE = ['preparing', 'running', 'waiting_input', 'finishing'] as const

export const captureJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'cache-control': 'private, no-store' } })

const STATUS: Record<CaptureError['error'], number> = { invalid: 400, too_large: 413, not_found: 404, conflict: 409, unavailable: 503 }
export const captureFailure = (failure: CaptureError) => captureJson({ error: failure.message, code: failure.error }, STATUS[failure.error])

/** Terminal runs are admitted only by routes that operate on an existing upload. */
export async function deviceRun(request: Request, runId: string, existingUpload = false): Promise<{ owner: CaptureOwner; caller: NonNullable<Awaited<ReturnType<typeof authenticateDevice>>>; deviceId: string } | Response> {
  const caller = await authenticateDevice(request)
  if (!caller) return captureJson({ error: 'Unauthorized' }, 401)
  if (!z.uuid().safeParse(runId).success) return captureJson({ error: 'Unknown run.' }, 404)
  const [run] = await db.select({ id: agentRuns.id, userId: agentRuns.userId, issueId: agentRuns.issueId, botId: agentRuns.botId, deviceId: agentRuns.deviceId })
    .from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(devices.ownerId, caller.userId), isNull(agentRuns.stopRequestedAt), inArray(agentRuns.status, existingUpload ? [...LIVE, 'succeeded', 'stopped', 'failed', 'cancelled'] : [...LIVE])))
    .limit(1)
  if (!run?.deviceId || (caller.scopeDeviceId && caller.scopeDeviceId !== run.deviceId)) return captureJson({ error: 'Unknown run.' }, 404)
  return { owner: { userId: run.userId, runId: run.id, issueId: run.issueId, botId: run.botId }, caller, deviceId: run.deviceId }
}
