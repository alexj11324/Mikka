import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { COMMANDS_MAX_SKIP, COMMANDS_MAX_WAIT_SECONDS, COMMANDS_SKIP_PARAM } from '@mikka/protocol/device'
import { authenticateDevice, ownedDevice, pendingCommands, queuedRuns, sleep, waitSeconds } from '@/lib/device-link'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'

/**
 * `GET /v1/devices/:deviceId/commands?wait=<seconds>`: messages people sent
 * this device's running agents, stops they asked for, and runs queued for it
 * (so the daemon claims a new run now, not on its next heartbeat). Long-polls
 * when nothing is pending.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  const device = await ownedDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const wait = waitSeconds(request, COMMANDS_MAX_WAIT_SECONDS)
  const skip = (new URL(request.url).searchParams.get(COMMANDS_SKIP_PARAM) ?? '')
    .split(',').filter(Boolean).slice(0, COMMANDS_MAX_SKIP)
  const deadline = Date.now() + wait * 1000
  while (!request.signal.aborted) {
    // A device with scheduling off gets no work (as GET .../runs).
    const [commands, queued] = await Promise.all([pendingCommands(deviceId, skip), device.enabled ? queuedRuns(deviceId, skip) : []])
    if (request.signal.aborted) break
    if (commands.length > 0 || queued.length > 0 || Date.now() >= deadline) {
      noteLogOutcome(commands.length > 0 || queued.length > 0 ? 'work' : 'empty')
      return NextResponse.json(queued.length > 0 ? { commands, queuedRuns: queued } : { commands })
    }
    await sleep(Math.min(1_000, Math.max(50, deadline - Date.now())), request.signal)
  }
  noteLogOutcome('ignored')
  return new NextResponse(null, { status: 204 })
}

export const GET = withRequestLog('/v1/devices/[deviceId]/commands', withDeviceRoute(handleGET))
