import { describe, expect, it } from "vitest"
import {
  GATE_EXPRESSIBLE_ACTIONS,
  HARNESS_TOOL_APPROVAL,
  harnessCanAsk,
  harnessToolApproval,
  policyAskActions,
  policyRequiresApproval,
  runApprovalStateSchema,
  runApprovalSupport,
} from "./harness-approval"
import { applyApprovalMode, defaultRunPolicy, type RunPolicy } from "./agent-policy"

/** A policy whose `install_dependency` is `ask`: the one action a native
 * per-call gate expresses, and therefore the one that makes a run ask. */
function askingPolicy(): RunPolicy {
  const base = defaultRunPolicy()
  return { ...base, permissions: { ...base.permissions, install_dependency: "ask" } }
}

describe("harness approval matrix", () => {
  it("names a native per-call surface only where the adapter has one", () => {
    expect(harnessToolApproval("claude_code")).toBe("native")
    expect(harnessToolApproval("codex")).toBe("native")
    // Cursor's ACP bridge accepts every tool; the mock replays a fixture.
    expect(harnessToolApproval("cursor")).toBe("unsupported")
    expect(harnessToolApproval("mock")).toBe("unsupported")
    expect(harnessCanAsk("claude_code")).toBe(true)
    expect(harnessCanAsk("cursor")).toBe(false)
  })

  it("answers null for a harness it has never heard of", () => {
    expect(harnessToolApproval("future_harness")).toBeNull()
    expect(harnessCanAsk("future_harness")).toBe(false)
  })

  it("covers every harness the protocol knows", () => {
    expect(Object.keys(HARNESS_TOOL_APPROVAL).sort()).toEqual(["claude_code", "codex", "cursor", "mock"])
  })
})

describe("when a run asks at all", () => {
  it("asks nothing on the defaults, so a plain run keeps bypassing approvals", () => {
    // Decision 2026-11-01-2335: a default run asks nothing per tool. The
    // defaults leave install_dependency at allow, so nothing is asked.
    expect(defaultRunPolicy().permissions.install_dependency).toBe("allow")
    expect(policyAskActions(defaultRunPolicy())).toEqual([])
    expect(policyRequiresApproval(defaultRunPolicy())).toBe(false)
  })

  it("asks installs when the policy says so, which is the only gate action", () => {
    expect(policyAskActions(askingPolicy())).toEqual(["install_dependency"])
    expect(policyRequiresApproval(askingPolicy())).toBe(true)
  })

  it("never asks on a read-only run: those actions are denied, not asked", () => {
    const readOnly = applyApprovalMode(askingPolicy(), "read_only")
    expect(readOnly.readOnly).toBe(true)
    expect(policyAskActions(readOnly)).toEqual([])
    expect(policyRequiresApproval(readOnly)).toBe(false)
  })

  it("does not treat an ask the sandbox or the broker already enforces as a tool ask", () => {
    // write_outside_repo and computer_use default to `ask`, but neither is a
    // CLI tool callback: routing them through the gate would change every
    // run's behavior. Only the gate-expressible actions count.
    const base = defaultRunPolicy()
    expect(base.permissions.write_outside_repo).toBe("ask")
    expect(policyAskActions(base)).toEqual([])
    expect(GATE_EXPRESSIBLE_ACTIONS).toEqual(["install_dependency"])
  })
})

describe("claim-time support", () => {
  it("refuses a run that must ask on a harness that cannot", () => {
    expect(runApprovalSupport(askingPolicy(), "claude_code")).toBe("required")
    expect(runApprovalSupport(askingPolicy(), "codex")).toBe("required")
    expect(runApprovalSupport(askingPolicy(), "cursor")).toBe("unsupported")
    expect(runApprovalSupport(askingPolicy(), "future_harness")).toBe("unsupported")
  })

  it("admits a run that asks nothing on any harness", () => {
    for (const harness of ["claude_code", "codex", "cursor", "mock"]) {
      expect(runApprovalSupport(defaultRunPolicy(), harness)).toBe("not_required")
    }
  })

  it("reports the asks and the revision it read them from", () => {
    const revision = "a".repeat(64)
    expect(runApprovalStateSchema.parse({ asks: ["install_dependency"], policyRevision: revision }))
      .toEqual({ asks: ["install_dependency"], policyRevision: revision })
    expect(runApprovalStateSchema.safeParse({ asks: ["install_dependency"], policyRevision: "not-a-revision" }).success).toBe(false)
    // An action the gate cannot express is not reportable as an ask.
    expect(runApprovalStateSchema.safeParse({ asks: ["network"], policyRevision: revision }).success).toBe(false)
  })
})
