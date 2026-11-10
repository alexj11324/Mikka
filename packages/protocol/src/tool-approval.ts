// One risky tool call waiting for the person's decision (#1730 Ask mode).
// The daemon names the exact operation; the server stores it under the run's
// frozen policy revision; the person decides; the daemon is woken by the
// decision. Nothing here grants an agent or workspace-wide authority: an
// approval is consumed by one request and expires on its own.
import { z } from 'zod'
import { harnessSchema } from './harness'

/** Stored input is masked and bounded; a larger request is refused, not cut. */
export const MAX_TOOL_APPROVAL_INPUT_CHARS = 16_000
export const MAX_TOOL_APPROVAL_REQUEST_ID = 200
export const TOOL_APPROVAL_TTL_MS = 10 * 60_000

export const TOOL_APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'cancelled', 'expired', 'consumed'] as const
export type ToolApprovalStatus = (typeof TOOL_APPROVAL_STATUSES)[number]

/** What a harness asks about: one tool, one command, one file change. */
export const TOOL_APPROVAL_METHODS = ['tool', 'command', 'file_change', 'mcp_tool'] as const
export type ToolApprovalMethod = (typeof TOOL_APPROVAL_METHODS)[number]

const requestId = z.string().trim().min(1).max(MAX_TOOL_APPROVAL_REQUEST_ID).regex(/^[A-Za-z0-9_.:-]+$/)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const maxInput = (value: unknown) => {
  try { return JSON.stringify(value ?? {}).length <= MAX_TOOL_APPROVAL_INPUT_CHARS } catch { return false }
}

export const toolApprovalInputSchema = z.record(z.string(), z.unknown()).refine(maxInput, { message: 'toolApprovalInputTooLarge' })

/** `POST /v1/runs/:runId/tool-approval` with `operation: 'request'`. */
export const toolApprovalRequestSchema = z.strictObject({
  operation: z.literal('request'),
  deviceId: z.uuid(),
  /** The exact run policy the daemon is gated on; a changed mode/policy refuses. */
  policyRevision: revision,
  /** Stable for one native request; a replay with another digest is refused. */
  requestId,
  harness: harnessSchema,
  method: z.enum(TOOL_APPROVAL_METHODS),
  /** Harness tool/command name, shown to the person; never instructions. */
  tool: z.string().trim().min(1).max(200),
  input: toolApprovalInputSchema,
})
export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestSchema>

/** `POST /v1/runs/:runId/tool-approval` with `operation: 'wait'`. */
export const toolApprovalWaitSchema = z.strictObject({
  operation: z.literal('wait'),
  deviceId: z.uuid(),
  approvalId: z.uuid(),
})
export type ToolApprovalWait = z.infer<typeof toolApprovalWaitSchema>

export const toolApprovalStateSchema = z.strictObject({
  approvalId: z.uuid(),
  status: z.enum(TOOL_APPROVAL_STATUSES),
  /** Epoch ms; the request is refused after this even if nobody decided. */
  expiresAt: z.number().int().nonnegative(),
})
export type ToolApprovalState = z.infer<typeof toolApprovalStateSchema>

/** The person's decision. Only the run's owner may send it. */
export const toolApprovalDecisionSchema = z.strictObject({ decision: z.enum(['approve', 'deny']) })
export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>

/** A terminal answer the daemon can act on without another read. */
export function toolApprovalDecided(state: ToolApprovalState, now = Date.now()): boolean {
  return state.status !== 'pending' || state.expiresAt <= now
}

/** The status a pending approval takes at time `now`. */
export function toolApprovalEffectiveStatus(status: ToolApprovalStatus, expiresAt: number, now = Date.now()): ToolApprovalStatus {
  return status === 'pending' && expiresAt <= now ? 'expired' : status
}
