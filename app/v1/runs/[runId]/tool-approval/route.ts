import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { AgentToolApprovalStore } from '@/lib/agent-tool-approval/store'

export const dynamic = 'force-dynamic'
const payload = z.object({ operation: z.literal('check'), deviceId: z.uuid(), policyRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { runId } = await params
  const parsed = payload.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(runId).success || !parsed.success || (caller.scopeDeviceId && caller.scopeDeviceId !== parsed.data.deviceId)) return Response.json({ error: 'invalidRequest' }, { status: 400 })
  const input = parsed.data; const actor = { userId: caller.userId, deviceId: input.deviceId }; const store = new AgentToolApprovalStore(pool)
  try {
    return Response.json(await store.checkState(actor, runId, input.policyRevision))
  } catch { return Response.json({ error: 'approvalUnavailable' }, { status: 409 }) }
}

export const POST = withDeviceRoute(handlePOST)
