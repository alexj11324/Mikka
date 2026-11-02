import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { AgentToolApprovalStore, ApprovalUnavailable } from '@/lib/agent-tool-approval/store'

export const dynamic = 'force-dynamic'
const payload = z.object({ operation: z.literal('check'), deviceId: z.uuid(), policyRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** Why a check answered as it did. Never the revisions, policy, token or body. */
type Reason = 'ok' | 'paused' | 'policy_revision_mismatch' | 'run_unavailable' | 'policy_changed' | 'policy_unavailable' | 'invalid_request' | 'unauthorized' | 'error'
type Note = { reason?: Reason; live?: boolean }
const unavailableReason = (error: unknown): Reason =>
  error instanceof ApprovalUnavailable ? 'run_unavailable'
    : error instanceof Error && error.message === 'agentPolicyChanged' ? 'policy_changed'
      : error instanceof Error && error.message === 'agentPolicyUnavailable' ? 'policy_unavailable' : 'error'

async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }, note: Note) {
  const caller = await authenticateDevice(request)
  if (!caller) { note.reason = 'unauthorized'; return Response.json({ error: 'unauthorized' }, { status: 401 }) }
  const { runId } = await params
  const parsed = payload.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(runId).success || !parsed.success || (caller.scopeDeviceId && caller.scopeDeviceId !== parsed.data.deviceId)) { note.reason = 'invalid_request'; return Response.json({ error: 'invalidRequest' }, { status: 400 }) }
  const input = parsed.data; const actor = { userId: caller.userId, deviceId: input.deviceId }; const store = new AgentToolApprovalStore(pool)
  try {
    const state = await store.checkState(actor, runId, input.policyRevision)
    note.live = state.live
    note.reason = !state.live ? 'policy_revision_mismatch' : state.paused ? 'paused' : 'ok'
    return Response.json(state)
  } catch (error) { note.reason = unavailableReason(error); return Response.json({ error: 'approvalUnavailable' }, { status: 409 }) }
}

const route = (request: Request, context: { params: Promise<{ runId: string }> }, note: Note) =>
  withDeviceRoute((req: Request, ctx: typeof context) => handlePOST(req, ctx, note))(request, context)

/** One line per liveness check: a daemon cancels its run on any answer but live. */
export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const started = performance.now(), note: Note = {}
  let status = 500
  try {
    const response = await route(request, context, note)
    status = response.status
    return response
  } finally {
    const runId = await context.params.then(p => p.runId, () => null)
    const entry = {
      level: status === 200 ? 'info' : status >= 500 ? 'error' : 'warn', msg: 'tool_approval_check', timestamp: new Date().toISOString(),
      runId: runId && z.uuid().safeParse(runId).success ? runId : null, live: note.live ?? false,
      reason: note.reason ?? (status === 401 ? 'unauthorized' : 'error'), status, durationMs: Math.round(performance.now() - started),
    }
    try { (entry.level === 'info' ? console.log : entry.level === 'warn' ? console.warn : console.error)(JSON.stringify(entry)) } catch { /* logging never breaks a check */ }
  }
}
