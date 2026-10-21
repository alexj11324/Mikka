import { NextResponse } from 'next/server'
import { COMMANDS_MAX_SKIP, COMMANDS_MAX_WAIT_SECONDS, COMMANDS_SKIP_PARAM } from '@mikka/protocol/device'
import { authenticateDevice, ownedDevice, pendingCommands, sleep, waitSeconds } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/**
 * `GET /v1/devices/:deviceId/commands?wait=<seconds>`: messages people sent
 * this device's running agents, and stops they asked for. Long-polls when
 * nothing is pending.
 */
export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const wait = waitSeconds(request, COMMANDS_MAX_WAIT_SECONDS)
  const skip = (new URL(request.url).searchParams.get(COMMANDS_SKIP_PARAM) ?? '')
    .split(',').filter(Boolean).slice(0, COMMANDS_MAX_SKIP)
  const deadline = Date.now() + wait * 1000
  for (;;) {
    const commands = await pendingCommands(deviceId, skip)
    if (commands.length > 0 || Date.now() >= deadline) return NextResponse.json({ commands })
    await sleep(Math.min(1_000, Math.max(50, deadline - Date.now())))
  }
}
