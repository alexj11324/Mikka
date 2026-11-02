import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { COMMANDS_MAX_SKIP, COMMANDS_MAX_WAIT_SECONDS, COMMANDS_SKIP_PARAM, MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'
import { authenticateDevice, deviceMayHaveWork, deviceWork, ownsDevice, sleep, waitSeconds } from '@/lib/device-link'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'

/** How often a waiting long-poll looks for new work. */
const IDLE_CHECK_MS = 2_000

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
  const device = await ownsDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const wait = waitSeconds(request, COMMANDS_MAX_WAIT_SECONDS)
  const skip = (new URL(request.url).searchParams.get(COMMANDS_SKIP_PARAM) ?? '')
    .split(',').filter(Boolean).slice(0, COMMANDS_MAX_SKIP)
  const deadline = Date.now() + wait * 1000
  while (!request.signal.aborted) {
    // A device with scheduling off gets no work (as GET .../runs).
    const options = { mailboxNotices: request.headers.get(MAILBOX_NOTICE_HEADER) === '1', queued: device.enabled }
    // The cheap check also ends the poll for a revoked credential; the full read hands over work.
    const { commands, queuedRuns: queued } = await deviceMayHaveWork(deviceId, skip, options) ? await deviceWork(deviceId, skip, options) : { commands: [], queuedRuns: [] }
    if (request.signal.aborted) break
    if (commands.length > 0 || queued.length > 0 || Date.now() >= deadline) {
      noteLogOutcome(commands.length > 0 || queued.length > 0 ? 'work' : 'empty')
      return NextResponse.json(queued.length > 0 ? { commands, queuedRuns: queued } : { commands })
    }
    // Each check is a database round trip under the device credential fence; every 2 s keeps an idle device cheap and a revoked credential loses a waiting poll within it (lib/device-revocation.db.test.ts).
    await sleep(Math.min(IDLE_CHECK_MS, Math.max(50, deadline - Date.now())), request.signal)
  }
  noteLogOutcome('ignored')
  return new NextResponse(null, { status: 204 })
}

export const GET = withRequestLog('/v1/devices/[deviceId]/commands', withDeviceRoute(handleGET))
