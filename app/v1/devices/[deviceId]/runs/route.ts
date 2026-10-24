import { mailboxes } from '@/lib/mailbox-runtime'
import { NextResponse } from 'next/server'
import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, sessionMailboxes } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** `GET /v1/devices/:deviceId/runs?state=queued`: runs waiting for this device. */
export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  const device = await ownedDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  // A device with scheduling off gets no work; it stays registered.
  if (!device.enabled) return NextResponse.json({ runIds: [] })
  await mailboxes.flush(caller.userId)
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns).leftJoin(sessionMailboxes, eq(sessionMailboxes.id, agentRuns.mailboxId))
    .where(and(eq(agentRuns.deviceId, deviceId), eq(agentRuns.status, 'queued'), isNull(agentRuns.stopRequestedAt), or(isNull(agentRuns.mailboxId), eq(sessionMailboxes.disabled, false))))
  return NextResponse.json({ runIds: rows.map(row => row.id) })
}
