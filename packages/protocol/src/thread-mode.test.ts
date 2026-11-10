import { describe, expect, it } from "vitest"
import {
  applyThreadMode,
  DEFAULT_THREAD_MODE,
  isThreadMode,
  resolveThreadMode,
  threadModeAllowsWithoutAsking,
  threadModeDenial,
  threadModeInstructions,
  threadModeSchema,
  threadModeStateSchema,
  threadModeSupport,
  threadModeTransitionSchema,
} from "./thread-mode"
import { defaultRunPolicy, isNoLooserThan, runPolicySchema } from "./agent-policy"

describe("thread mode contract (#1730)", () => {
  it("accepts only plan, execute and ask, and defaults a bad stored value to execute", () => {
    expect(threadModeSchema.options).toEqual(["plan", "execute", "ask"])
    expect(DEFAULT_THREAD_MODE).toBe("execute")
    expect(resolveThreadMode("plan")).toBe("plan")
    for (const value of [undefined, null, "", "PLAN", "read_only", 1, {}]) {
      expect(isThreadMode(value)).toBe(false)
      expect(resolveThreadMode(value)).toBe("execute")
    }
  })

  it("plan is the existing read-only policy and never loosens execute", () => {
    const execute = defaultRunPolicy()
    const plan = applyThreadMode(execute, "plan")
    expect(plan.readOnly).toBe(true)
    expect(plan.permissions.write_outside_repo).toBe("deny")
    expect(plan.permissions.install_dependency).toBe("deny")
    expect(plan.permissions.computer_use).toBe("deny")
    // The mode can only remove capabilities, never add one.
    expect(isNoLooserThan(execute, plan)).toBe(true)
    expect(isNoLooserThan(plan, execute)).toBe(false)
    // Plan stays a valid wire policy.
    expect(runPolicySchema.safeParse(plan).success).toBe(true)
  })

  it("execute and ask leave the stored policy exactly as it was", () => {
    const execute = defaultRunPolicy()
    expect(applyThreadMode(execute, "execute")).toBe(execute)
    expect(applyThreadMode(execute, "ask")).toBe(execute)
  })

  it("only execute permits a write, external effect or merge without asking", () => {
    for (const mode of ["plan", "ask"] as const) {
      expect(threadModeAllowsWithoutAsking(mode, "read")).toBe(true)
      for (const effect of ["write", "external", "merge"] as const) {
        expect(threadModeAllowsWithoutAsking(mode, effect)).toBe(false)
        expect(threadModeDenial(mode, effect)).toBe(mode === "plan" ? "threadModePlanReadOnly" : null)
      }
    }
    for (const effect of ["read", "write", "external", "merge"] as const)
      expect(threadModeAllowsWithoutAsking("execute", effect)).toBe(true)
  })

  it("tells the agent what the mode means without pretending to be the sandbox", () => {
    expect(threadModeInstructions("execute")).toEqual([])
    expect(threadModeInstructions("plan")[0]).toContain("Plan mode")
    expect(threadModeInstructions("plan")[0]).toContain("Do not change files")
    expect(threadModeInstructions("ask")[0]).toContain("Ask mode")
    expect(threadModeInstructions("ask")[0]).toContain("waits for the person")
  })

  it("reflects each harness's native ask support and refuses an unknown one", () => {
    expect(threadModeSupport("claude_code", "ask")).toBe("enforced")
    expect(threadModeSupport("codex", "ask")).toBe("enforced")
    expect(threadModeSupport("cursor", "ask")).toBe("unsupported")
    expect(threadModeSupport("mock", "ask")).toBe("unsupported")
    expect(threadModeSupport("claude_code", "plan")).toBe("enforced")
    expect(threadModeSupport("cursor", "plan")).toBe("unsupported")
    expect(threadModeSupport("future_harness", "plan")).toBeNull()
  })

  it("fences API transitions with a version", () => {
    expect(threadModeTransitionSchema.parse({ mode: "plan", expectedVersion: 3 })).toEqual({ mode: "plan", expectedVersion: 3 })
    expect(threadModeTransitionSchema.safeParse({ mode: "plan", expectedVersion: -1 }).success).toBe(false)
    expect(threadModeTransitionSchema.safeParse({ mode: "execute", expectedVersion: 0, extra: true }).success).toBe(false)
    expect(threadModeStateSchema.parse({ mode: "ask", version: 2, frozenMode: "plan", policyRevision: "a".repeat(64) }))
      .toEqual({ mode: "ask", version: 2, frozenMode: "plan", policyRevision: "a".repeat(64) })
    expect(threadModeStateSchema.safeParse({ mode: "ask", version: 2, policyRevision: "not-a-revision" }).success).toBe(false)
  })
})
