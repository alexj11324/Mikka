import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { nativeCoordinatorCommandSchema } from '@mikka/protocol/coordinator'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { nativeCoordinatorEnabled, nativeCoordinatorStore } from '@/lib/coordinator/native'
import { NativeCoordinatorError } from '@/lib/coordinator/native-store'
import { maskForWorkspace } from '@/lib/secrets/runtime'

export const dynamic = 'force-dynamic'
const bodySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('claim') }).strict(),
  z.object({ operation: z.literal('submit'), turnId: z.uuid(), command: nativeCoordinatorCommandSchema }).strict(),
  z.object({ operation: z.literal('result'), turnId: z.uuid(), callId: z.string().min(1).max(200) }).strict(),
])
/** The device token never receives a database credential or another person's tools/context. */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  if (!nativeCoordinatorEnabled()) return NextResponse.json({ error: 'notEnabled' }, { status: 404 })
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const raw = await request.text()
  if (raw.length > 550_000) return NextResponse.json({ error: 'payloadTooLarge' }, { status: 413 })
  let json: unknown
  try { json = JSON.parse(raw) } catch { return NextResponse.json({ error: 'invalidRequest' }, { status: 400 }) }
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'invalidRequest' }, { status: 400 })
  const body = parsed.data
  try {
    if (body.operation === 'claim') return NextResponse.json({ job: await nativeCoordinatorStore.claim(caller.userId,deviceId) })
    if (body.operation === 'result') return NextResponse.json(await nativeCoordinatorStore.result(caller.userId,deviceId,body.turnId,body.callId))
    // 4e2 item 4: a coordinator command from a cloud worker is persisted; masked with the worker's workspace set.
    await nativeCoordinatorStore.submit(caller.userId,deviceId,body.turnId,await maskForWorkspace(caller.scopeWorkspaceId, body.command))
    return NextResponse.json({ accepted: true })
  } catch (error) {
    if (error instanceof NativeCoordinatorError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}

export const POST = withDeviceRoute(handlePOST)
