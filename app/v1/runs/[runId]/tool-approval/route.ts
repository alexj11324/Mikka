import { z } from 'zod'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { AgentToolApprovalStore } from '@/lib/agent-tool-approval/store'
import { maskForWorkspace } from '@/lib/secrets/runtime'

export const dynamic = 'force-dynamic'
const payload = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('check'), deviceId: z.uuid(), policyRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ operation: z.literal('propose'), policyRevision: z.string().regex(/^[a-f0-9]{64}$/), deviceId: z.uuid(), requestId: z.string().min(1).max(256), harness: z.enum(['codex','claude_code']), method: z.string().min(1).max(128), input: z.unknown() }).strict(),
  z.object({ operation: z.literal('take'), deviceId: z.uuid(), id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ operation: z.literal('cancel'), deviceId: z.uuid(), id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
])
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { runId } = await params
  const parsed = payload.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(runId).success || !parsed.success || (caller.scopeDeviceId && caller.scopeDeviceId !== parsed.data.deviceId)) return Response.json({ error: 'invalidRequest' }, { status: 400 })
  const input = parsed.data; const actor = { userId: caller.userId, deviceId: input.deviceId }; const store = new AgentToolApprovalStore(pool)
  try {
    if (input.operation === 'check') return Response.json(await store.checkState(actor, runId, input.policyRevision))
    if (input.operation === 'propose') return Response.json(await store.propose(actor, { runId, requestId: input.requestId, harness: input.harness, method: input.method, input: await maskForWorkspace(caller.scopeWorkspaceId, input.input), originalInput: input.input, policyRevision: input.policyRevision }))
    if (input.operation === 'take') return Response.json({ decision: await store.take(actor, runId, input.id, input.digest) })
    return Response.json({ cancelled: await store.cancel(actor, runId, input.id, input.digest) })
  } catch { return Response.json({ error: 'approvalUnavailable' }, { status: 409 }) }
}
