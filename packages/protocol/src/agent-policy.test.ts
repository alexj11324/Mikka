import { describe, expect, it } from "vitest"

import {
  APPROVAL_MODES,
  CONFIGURABLE_ACTIONS,
  DEFAULT_NETWORK_ALLOW,
  FIXED_PERMISSIONS,
  PERMISSION_ACTIONS,
  PERMISSION_DEFAULTS,
  applyApprovalMode,
  isNoLooserThan,
  modelForHarness,
  networkAllowSchema,
  resolveAgentSettings,
  resolveApprovalMode,
  resolveDefaultHarness,
  resolveInstructions,
  resolveModelByHarness,
  resolvePermissions,
  storedPermissionsSchema,
} from "./agent-policy"
import { runAssignmentSchema } from "./device"

describe("agent policy table (ADR 0009)", () => {
  it("splits every action into fixed or configurable", () => {
    const fixed = Object.keys(FIXED_PERMISSIONS)
    expect([...fixed, ...CONFIGURABLE_ACTIONS].sort()).toEqual(
      [...PERMISSION_ACTIONS].sort()
    )
  })

  it("keeps the ADR defaults", () => {
    expect(PERMISSION_DEFAULTS).toEqual({
      read_in_worktree: "allow",
      write_in_worktree: "allow",
      run_project_script: "allow",
      run_setup_recipe: "allow",
      install_dependency: "ask",
      write_outside_repo: "ask",
      git_push: "ask",
      network: "ask",
    })
  })

  it("refuses choices an action does not offer", () => {
    expect(
      storedPermissionsSchema.safeParse({ write_outside_repo: "allow" }).success
    ).toBe(false)
    expect(
      storedPermissionsSchema.safeParse({ read_in_worktree: "deny" }).success
    ).toBe(false)
    expect(
      storedPermissionsSchema.safeParse({ git_push: "deny", network: "allow" })
        .success
    ).toBe(true)
  })

  it("falls back to defaults for stored values that are not allowed", () => {
    expect(
      resolvePermissions({ write_outside_repo: "allow", git_push: "deny" })
    ).toEqual({
      install_dependency: "ask",
      write_outside_repo: "ask",
      git_push: "deny",
      network: "ask",
    })
  })

  it("normalizes the domain list and refuses a bare wildcard", () => {
    expect(
      networkAllowSchema.parse([" NPMJS.org ", "*.github.com", "npmjs.org"])
    ).toEqual(["npmjs.org", "*.github.com"])
    expect(networkAllowSchema.safeParse(["*"]).success).toBe(false)
    expect(networkAllowSchema.safeParse(["http://x.com"]).success).toBe(false)
    expect(networkAllowSchema.safeParse(["localhost:5432"]).success).toBe(true)
  })
})

describe("resolveAgentSettings", () => {
  it("uses the defaults without a row", () => {
    const resolved = resolveAgentSettings(null)
    expect(resolved.policy.networkAllow).toEqual(DEFAULT_NETWORK_ALLOW)
    expect(resolved.guidance).toBeNull()
  })

  it("lets a team replace the workspace guidance, or clear it", () => {
    const workspace = { guidance: "Write tests.", networkAllow: [] }
    expect(resolveAgentSettings(workspace).guidance).toBe("Write tests.")
    expect(resolveAgentSettings(workspace, { guidance: null })).toMatchObject({
      guidance: "Write tests.",
      guidanceFrom: "workspace",
    })
    expect(
      resolveAgentSettings(workspace, { guidance: "Use Rust." })
    ).toMatchObject({ guidance: "Use Rust.", guidanceFrom: "team" })
    expect(resolveAgentSettings(workspace, { guidance: "  " })).toMatchObject({
      guidance: null,
      guidanceFrom: null,
    })
    expect(resolveAgentSettings(workspace).policy.networkAllow).toEqual([])
  })

  it("travels in the run assignment", () => {
    const policy = resolveAgentSettings({
      permissions: { network: "deny" },
    }).policy
    const parsed = runAssignmentSchema.parse({
      runId: "r1",
      issueId: "i1",
      deviceId: "d1",
      repoId: "p1",
      baseBranch: "main",
      harness: "mock",
      prompt: "x",
      policy,
    })
    expect(parsed.policy?.permissions.network).toBe("deny")
  })
})

describe("a person's approval mode (ADR 0060)", () => {
  const workspace = resolveAgentSettings({
    permissions: { install_dependency: "allow", network: "allow" },
    networkAllow: ["example.com"],
  }).policy

  it("leaves the workspace's policy alone on ask", () => {
    expect(applyApprovalMode(workspace, "ask")).toEqual(workspace)
  })

  it("takes the changing actions away on read_only, and never gives any back", () => {
    const readOnly = applyApprovalMode(workspace, "read_only")
    expect(readOnly.permissions).toEqual({
      install_dependency: "deny",
      write_outside_repo: "deny",
      git_push: "deny",
      // Network stays as the workspace set it: a read-only run still has to
      // reach its model's API (ADR 0046).
      network: "allow",
    })
    expect(readOnly.readOnly).toBe(true)
    expect(readOnly.networkAllow).toEqual(["example.com"])
  })

  it("offers only modes that are no looser than the workspace, whatever it chose", () => {
    // Every workspace the policy table can produce, including the loosest.
    const policies = [
      resolveAgentSettings(null).policy,
      workspace,
      resolveAgentSettings({
        permissions: {
          install_dependency: "allow",
          write_outside_repo: "deny",
          git_push: "allow",
          network: "deny",
        },
      }).policy,
    ]
    for (const policy of policies) {
      for (const mode of APPROVAL_MODES) {
        const applied = applyApprovalMode(policy, mode)
        expect(isNoLooserThan(policy, applied)).toBe(true)
      }
    }
  })

  it("catches a policy that does loosen one, so the check above means something", () => {
    const looser = {
      ...workspace,
      permissions: { ...workspace.permissions, git_push: "allow" as const },
    }
    expect(
      isNoLooserThan(
        {
          ...workspace,
          permissions: { ...workspace.permissions, git_push: "deny" },
        },
        looser
      )
    ).toBe(false)
    expect(isNoLooserThan({ ...workspace, readOnly: true }, workspace)).toBe(
      false
    )
  })

  it("reads back only a mode the protocol has", () => {
    expect(resolveApprovalMode("read_only")).toBe("read_only")
    expect(resolveApprovalMode("ask")).toBe("ask")
    expect(resolveApprovalMode("autonomous")).toBe("ask")
    expect(resolveApprovalMode(null)).toBe("ask")
  })
})

describe("a person's model per harness (ADR 0060)", () => {
  it("keeps the harnesses the person set and drops the rest", () => {
    expect(
      resolveModelByHarness({ claude_code: "sonnet", codex: "  " })
    ).toEqual({ claude_code: "sonnet" })
  })

  it("ignores a harness the protocol has no model for, and a name that is not one", () => {
    expect(resolveModelByHarness({ mock: "whatever" })).toEqual({})
    expect(resolveModelByHarness({ claude_code: 7 })).toEqual({})
    expect(resolveModelByHarness("sonnet")).toEqual({})
    expect(resolveModelByHarness(null)).toEqual({})
  })

  it("answers with the model of the harness the run is on, or nothing", () => {
    const stored = { claude_code: "sonnet", cursor: "gpt-5" }
    expect(modelForHarness(stored, "claude_code")).toBe("sonnet")
    expect(modelForHarness(stored, "codex")).toBeNull()
    // The mock has no model, so it never gets one from a preference.
    expect(modelForHarness(stored, "mock")).toBeNull()
  })

  it("travels in the run assignment, and is absent when unset", () => {
    const base = {
      runId: "r1",
      issueId: "i1",
      deviceId: "d1",
      repoId: "p1",
      baseBranch: "main",
      harness: "claude_code" as const,
      prompt: "x",
    }
    expect(runAssignmentSchema.parse({ ...base, model: "sonnet" }).model).toBe(
      "sonnet"
    )
    expect(runAssignmentSchema.parse(base).model).toBeUndefined()
    // A blank model is not a model.
    expect(
      runAssignmentSchema.safeParse({ ...base, model: "  " }).success
    ).toBe(false)
  })
})

describe("a person's own instructions (ADR 0060)", () => {
  it("trims what is there and answers null for a blank or a non-string", () => {
    expect(resolveInstructions("  Read docs/CONTRIBUTING.md. ")).toBe(
      "Read docs/CONTRIBUTING.md."
    )
    expect(resolveInstructions("   ")).toBeNull()
    expect(resolveInstructions(null)).toBeNull()
    expect(resolveInstructions(7)).toBeNull()
  })

  it("reads back only a harness that can be a default", () => {
    expect(resolveDefaultHarness("codex")).toBe("codex")
    expect(resolveDefaultHarness("mock")).toBeNull()
    expect(resolveDefaultHarness("")).toBeNull()
    expect(resolveDefaultHarness(undefined)).toBeNull()
  })
})
