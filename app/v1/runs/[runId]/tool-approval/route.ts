import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { isDeviceAuthorityError, isDeviceAuthorityRevoked } from '@/lib/db/device-scope'
import { AgentToolApprovalStore, ApprovalUnavailable } from '@/lib/agent-tool-approval/store'
import { toolApprovalDecided, toolApprovalRequestSchema, toolApprovalWaitSchema, type ToolApprovalState } from '@mikka/protocol/tool-approval'
import { RUN_APPROVAL_CHANNEL, subscribeShared } from '@/lib/db/listen'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
const checkPayload = z.object({ operation: z.literal('check'), deviceId: z.uuid(), policyRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const consumePayload = z.strictObject({ operation: z.literal('consume'), deviceId: z.uuid(), approvalId: z.uuid() })
const payload = z.discriminatedUnion('operation', [checkPayload, toolApprovalRequestSchema, toolApprovalWaitSchema, consumePayload])
type Payload = z.infer<typeof payload>
/** One long poll of a decision; the daemon asks again only while pending. */
const WAIT_MS = 20_000
/** Only when LISTEN is unavailable: the same bounded fallback the commands poll keeps. */
const LISTEN_FALLBACK_MS = 5_000

/** Why a check answered as it did. Never the revisions, policy, token or body. */
type Reason = 'ok' | 'paused' | 'policy_revision_mismatch' | 'run_unavailable' | 'lease_revoked' | 'policy_changed' | 'policy_unavailable' | 'invalid_request' | 'unauthorized' | 'authority_unavailable' | 'database_unavailable' | 'error'
type Note = { reason?: Reason; live?: boolean; databaseCode?: string }
const DATABASE_CODES = new Set(['40001', '40P01', '55P03', '57014', '08001', '08006', '53300', '57P01'])
/** Bounded SQL-state diagnosis only: never error text, stack or a getter. */
function databaseCode(error: unknown): string | undefined {
  const seen = new Set<Error>()
  for (let depth = 0; depth < 8 && error instanceof Error && !seen.has(error); depth++) {
    seen.add(error)
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof code === 'string' && DATABASE_CODES.has(code)) return code
    error = Object.getOwnPropertyDescriptor(error, 'cause')?.value
  }
}
const unavailableReason = (error: unknown): Reason =>
  error instanceof ApprovalUnavailable ? 'run_unavailable'
    : error instanceof Error && error.message === 'agentPolicyChanged' ? 'policy_changed'
      : error instanceof Error && error.message === 'agentPolicyUnavailable' ? 'policy_unavailable' : 'error'

/** Wait for one decision over LISTEN; a lost listener falls back to a bounded re-read. */
async function waitForDecision(actor: { userId: string; deviceId: string }, runId: string, approvalId: string, signal: AbortSignal): Promise<ToolApprovalState> {
  const { RunToolApprovalStore } = await import('@/lib/agent-tool-approval/approvals')
  const store = new RunToolApprovalStore(pool)
  const deadline = Date.now() + WAIT_MS
  const subscription = await subscribeShared(pool, RUN_APPROVAL_CHANNEL, [approvalId], signal).catch(() => null)
  try {
    while (!signal.aborted) {
      subscription?.reset()
      const state = await store.state(actor, runId, approvalId)
      if (toolApprovalDecided(state)) return state
      const remaining = deadline - Date.now()
      if (remaining <= 0) return state
      if (subscription && !subscription.lost) await subscription.next(remaining, signal)
      else await new Promise(resolve => setTimeout(resolve, Math.min(LISTEN_FALLBACK_MS, remaining)))
    }
    throw new ApprovalUnavailable()
  } finally { subscription?.close() }
}

async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }, note: Note) {
  const caller = await authenticateDevice(request)
  if (!caller) { note.reason = 'unauthorized'; return Response.json({ error: 'unauthorized' }, { status: 401 }) }
  const { runId } = await params
  const parsed = payload.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(runId).success || !parsed.success || (caller.scopeDeviceId && caller.scopeDeviceId !== parsed.data.deviceId)) { note.reason = 'invalid_request'; return Response.json({ error: 'invalidRequest' }, { status: 400 }) }
  const input: Payload = parsed.data; const actor = { userId: caller.userId, deviceId: input.deviceId }
  try {
    if (input.operation === 'request') {
      note.reason = 'ok'
      const { RunToolApprovalStore } = await import('@/lib/agent-tool-approval/approvals')
      return Response.json(await new RunToolApprovalStore(pool).request(actor, runId, input))
    }
    if (input.operation === 'wait') {
      note.reason = 'ok'
      return Response.json(await waitForDecision(actor, runId, input.approvalId, request.signal))
    }
    if (input.operation === 'consume') {
      note.reason = 'ok'
      const { RunToolApprovalStore } = await import('@/lib/agent-tool-approval/approvals')
      return Response.json(await new RunToolApprovalStore(pool).consume(actor, runId, input.approvalId))
    }
    const state = await new AgentToolApprovalStore(pool).checkState(actor, runId, input.policyRevision)
    note.live = state.live
    note.reason = !state.live ? 'policy_revision_mismatch' : state.paused ? 'paused' : 'ok'
    return Response.json(state)
  } catch (error) {
    if (error instanceof ApprovalUnavailable && error.revokeReason === 'device_lost') {
      note.live = false
      note.reason = 'lease_revoked'
      return Response.json({ live: false, revokeReason: error.revokeReason })
    }
    // Preserve the device wrapper's immediate 401 for revocation and its
    // retryable 503 for an unavailable fence. Neither grants liveness.
    if (isDeviceAuthorityError(error)) {
      note.reason = isDeviceAuthorityRevoked(error) ? 'unauthorized' : 'authority_unavailable'
      throw error
    }
    note.reason = unavailableReason(error)
    if (note.reason === 'error') {
      note.databaseCode = databaseCode(error)
      if (note.databaseCode) {
        note.reason = 'database_unavailable'
        return Response.json({ error: 'approvalUnavailable' }, { status: 503, headers: { 'Retry-After': '2' } })
      }
    }
    // A typed reason tells the daemon which fence refused; never inputs or policy bytes.
    const reason = error instanceof ApprovalUnavailable ? error.revokeReason : undefined
    return Response.json({ error: 'approvalUnavailable', ...(reason ? { reason } : {}) }, { status: 409 })
  }
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
      ...(note.databaseCode ? { databaseCode: note.databaseCode } : {}),
    }
    try { (entry.level === 'info' ? console.log : entry.level === 'warn' ? console.warn : console.error)(JSON.stringify(entry)) } catch { /* logging never breaks a check */ }
  }
}
