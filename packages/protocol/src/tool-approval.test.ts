import { describe, expect, it } from "vitest"
import {
  MAX_TOOL_APPROVAL_INPUT_CHARS,
  toolApprovalDecided,
  toolApprovalDecisionSchema,
  toolApprovalEffectiveStatus,
  toolApprovalRequestSchema,
  toolApprovalStateSchema,
  toolApprovalWaitSchema,
} from "./tool-approval"

const request = {
  operation: "request" as const,
  deviceId: "7b0f3c9e-2d4a-4e1b-9c3d-5f6a7b8c9d0e",
  policyRevision: "a".repeat(64),
  requestId: "turn-1:toolu_01",
  harness: "claude_code" as const,
  method: "tool" as const,
  tool: "Bash",
  input: { command: "npm test" },
}

describe("one Ask request (#1730)", () => {
  it("accepts the exact run-bound request shape", () => {
    expect(toolApprovalRequestSchema.parse(request)).toEqual(request)
    expect(toolApprovalWaitSchema.parse({ operation: "wait", deviceId: request.deviceId, approvalId: request.deviceId }))
      .toEqual({ operation: "wait", deviceId: request.deviceId, approvalId: request.deviceId })
  })

  it("rejects a widened or malformed request instead of trimming it", () => {
    expect(toolApprovalRequestSchema.safeParse({ ...request, policyRevision: "short" }).success).toBe(false)
    expect(toolApprovalRequestSchema.safeParse({ ...request, requestId: "has spaces" }).success).toBe(false)
    expect(toolApprovalRequestSchema.safeParse({ ...request, harness: "future" }).success).toBe(false)
    expect(toolApprovalRequestSchema.safeParse({ ...request, operation: "approve" }).success).toBe(false)
    expect(toolApprovalRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
    expect(toolApprovalRequestSchema.safeParse({ ...request, input: { blob: "x".repeat(MAX_TOOL_APPROVAL_INPUT_CHARS) } }).success).toBe(false)
  })

  it("has one decision vocabulary and a bounded state", () => {
    expect(toolApprovalDecisionSchema.parse({ decision: "approve" })).toEqual({ decision: "approve" })
    expect(toolApprovalDecisionSchema.safeParse({ decision: "allow" }).success).toBe(false)
    const state = { approvalId: request.deviceId, status: "pending" as const, expiresAt: 1_800_000_000_000 }
    expect(toolApprovalStateSchema.parse(state)).toEqual(state)
    expect(toolApprovalStateSchema.safeParse({ ...state, expiresAt: -1 }).success).toBe(false)
    expect(toolApprovalStateSchema.safeParse({ ...state, status: "maybe" }).success).toBe(false)
  })

  it("a pending request becomes expired at its deadline, never silently allowed", () => {
    expect(toolApprovalEffectiveStatus("pending", 100, 99)).toBe("pending")
    expect(toolApprovalEffectiveStatus("pending", 100, 100)).toBe("expired")
    expect(toolApprovalEffectiveStatus("approved", 100, 200)).toBe("approved")
    expect(toolApprovalDecided({ approvalId: request.deviceId, status: "pending", expiresAt: 100 }, 100)).toBe(true)
    expect(toolApprovalDecided({ approvalId: request.deviceId, status: "denied", expiresAt: 100 }, 1)).toBe(true)
    expect(toolApprovalDecided({ approvalId: request.deviceId, status: "approved", expiresAt: 100 }, 1)).toBe(true)
    expect(toolApprovalDecided({ approvalId: request.deviceId, status: "pending", expiresAt: 100 }, 50)).toBe(false)
  })
})
