import { z } from 'zod'
import { CodingWorkspaceError, workspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { withDeviceRoute } from '@/lib/device-route'
import { authenticateDevice, ownsDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { finishWorkspaceRead } from '@/lib/coding-workspace/requests'

async function handlePOST(request: Request, context: { params: Promise<{ deviceId: string; requestId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return new Response(null, { status: 401 })
  const { deviceId, requestId } = await context.params
  if (!z.uuid().safeParse(deviceId).success || !z.uuid().safeParse(requestId).success || !await ownsDevice(deviceId, caller.userId)) return new Response(null, { status: 404 })
  // Bound the byte stream before JSON parsing; content-length is not trusted.
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400 })
  const buffers: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 4 * 1024 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }) }
      buffers.push(value)
    }
    let data: unknown
    try { data = JSON.parse(Buffer.concat(buffers).toString('utf8')) } catch { return new Response(null, { status: 400 }) }
    const parsed = workspaceReadReceipt.safeParse(data)
    if (!parsed.success) return new Response(null, { status: 400 })
    const saved = await finishWorkspaceRead(pool, workspacePool, caller, deviceId, requestId, parsed.data)
    return new Response(null, { status: saved ? 204 : 409 })
  } catch (error) {
    if (error instanceof CodingWorkspaceError) return new Response(null, { status: 409 })
    throw error
  } finally { reader.releaseLock() }
}

export const POST = withDeviceRoute(handlePOST)
