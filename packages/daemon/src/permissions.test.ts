import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  PACKAGE_REGISTRY_DOMAINS,
  resolveAgentSettings,
  type RunPolicy,
} from "@mikka/protocol/agent-policy"

import { acpPermissionResponse } from "./adapters/cursor"
import { claudeSandboxSettings, claudeSettings } from "./adapters/claude"
import { runInstructions } from "./agents/run-context"
import {
  PERMISSION_DEFAULTS,
  classifyCommand,
  classifyWrite,
  claudePermissionRules,
  decide,
  policyInstructions,
  pushDecision,
  runDomains,
  rawCliShellAvailable,
} from "./permissions"

describe("permission policy (ADR 0009)", () => {
  it.each([
    ["read_in_worktree", "allow"],
    ["write_in_worktree", "allow"],
    ["run_project_script", "allow"],
    ["install_dependency", "ask"],
    ["write_outside_repo", "ask"],
    ["git_push", "ask"],
    ["network", "ask"],
    ["computer_use", "ask"],
  ] as const)("%s -> %s", (action, expected) => {
    expect(PERMISSION_DEFAULTS[action]).toBe(expected)
    expect(decide(action)).toBe(expected)
  })

  it("allows the setup recipe only once approved", () => {
    expect(decide("run_setup_recipe")).toBe("ask")
    expect(decide("run_setup_recipe", { setupRecipeApproved: true })).toBe(
      "allow"
    )
  })

  it("asks for unknown actions", () => {
    expect(decide("format_disk")).toBe("ask")
    expect(decide("__proto__")).toBe("ask")
    expect(decide("format_disk", { policy: { ...policy({}), readOnly: true } })).toBe("deny")
    expect(decide("__proto__", { policy: { ...policy({}), readOnly: true } })).toBe("deny")
  })

  it("classifies writes by worktree boundary", () => {
    expect(classifyWrite("/wt/run-1", "src/a.ts")).toBe("write_in_worktree")
    expect(classifyWrite("/wt/run-1", "/wt/run-1/b.ts")).toBe(
      "write_in_worktree"
    )
    expect(classifyWrite("/wt/run-1", "../run-2/a.ts")).toBe(
      "write_outside_repo"
    )
    expect(classifyWrite("/wt/run-1", "/etc/hosts")).toBe("write_outside_repo")
  })

  it("follows symlinks: a link in the worktree to outside is outside", () => {
    const base = mkdtempSync(join(tmpdir(), "orvp-"))
    try {
      const worktree = join(base, "wt")
      const outside = join(base, "outside")
      mkdirSync(worktree)
      mkdirSync(outside)
      symlinkSync(outside, join(worktree, "linked-dir"))
      symlinkSync(join(outside, "f.txt"), join(worktree, "linked-file"))
      expect(classifyWrite(worktree, "linked-dir/new/a.txt")).toBe(
        "write_outside_repo"
      )
      expect(classifyWrite(worktree, "linked-file")).toBe("write_outside_repo")
      expect(classifyWrite(worktree, "real/new.txt")).toBe("write_in_worktree")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

function policy(
  permissions: Partial<RunPolicy["permissions"]>,
  networkAllow: string[] = ["github.com"]
): RunPolicy {
  return resolveAgentSettings({ permissions, networkAllow }).policy
}

describe("applying the workspace's policy (ADR 0028)", () => {
  it("decides configurable actions from the policy, fixed ones from the table", () => {
    const p = policy({ install_dependency: "deny", git_push: "allow" })
    expect(decide("install_dependency", { policy: p })).toBe("deny")
    expect(decide("git_push", { policy: p })).toBe("allow")
    expect(decide("network", { policy: p })).toBe("ask")
    expect(decide("write_in_worktree", { policy: p })).toBe("allow")
    expect(decide("run_setup_recipe", { policy: p })).toBe("ask")
  })

  it("uses only the run computer permission and makes read-only take precedence", () => {
    for (const decision of ["allow", "ask", "deny"] as const) {
      const p = policy({ computer_use: decision })
      expect(decide("computer_use", { policy: p })).toBe(decision)
      expect(decide("computer_use", { policy: { ...p, readOnly: true } })).toBe("deny")
    }
    const legacy = policy({})
    delete legacy.permissions.computer_use
    expect(decide("computer_use", { policy: legacy })).toBe("ask")
    expect(decide("computer_use", { policy: { ...legacy, readOnly: true } })).toBe("deny")
  })

  it("builds the run's domain list from network and install choices", () => {
    expect(runDomains(policy({}), ["npmjs.org"])).toEqual([
      "github.com",
      "npmjs.org",
    ])
    expect(runDomains(policy({ network: "allow" }), ["npmjs.org"])).toEqual([
      "*",
    ])
    expect(runDomains(policy({ network: "deny" }), ["npmjs.org"])).toEqual([])
    expect(
      runDomains(policy({ network: "deny", install_dependency: "allow" }))
    ).toEqual([])
    expect(runDomains(policy({ install_dependency: "allow" }))).toEqual([
      "github.com",
      ...PACKAGE_REGISTRY_DOMAINS,
    ])
  })

  it("pushes by the workspace's choice and the repo's approval", () => {
    expect(pushDecision(policy({}), false)).toEqual({
      push: false,
      note: "Push needs approval for this repo",
    })
    expect(pushDecision(policy({}), true)).toEqual({ push: true })
    expect(pushDecision(policy({ git_push: "allow" }), false)).toEqual({
      push: true,
    })
    expect(pushDecision(policy({ git_push: "deny" }), true)).toEqual({
      push: false,
      note: "Push is turned off for this workspace",
    })
  })

  it("denies every write to a read-only check, whatever the workspace chose (ADR 0046)", () => {
    const p: RunPolicy = {
      ...policy({ install_dependency: "allow", git_push: "allow" }),
      readOnly: true,
    }
    expect(decide("write_in_worktree", { policy: p })).toBe("deny")
    expect(decide("write_outside_repo", { policy: p })).toBe("deny")
    expect(decide("run_project_script", { policy: p })).toBe("deny")
    expect(decide("install_dependency", { policy: p })).toBe("deny")
    expect(decide("git_push", { policy: p })).toBe("deny")
    // Reading is the whole point of the check.
    expect(decide("read_in_worktree", { policy: p })).toBe("allow")
    // A read-only check never pushes, even on an approved repo.
    expect(pushDecision(p, true)).toEqual({
      push: false,
      note: "A read-only check does not push",
    })
    // The CLI is told the same, and never offered an install.
    expect(claudePermissionRules(p)).toMatchObject({
      ask: [],
      deny: expect.arrayContaining([
        "Bash(git push:*)",
        "Write",
        "Edit",
        "Bash(npm install:*)",
      ]),
    })
    expect(policyInstructions(p)[0]).toContain("read-only check")
  })

  it("classifies shell commands", () => {
    expect(classifyCommand("npm install left-pad")).toBe("install_dependency")
    expect(classifyCommand("cd web && pnpm add zod")).toBe("install_dependency")
    expect(classifyCommand("CI=1 /usr/bin/pip install x")).toBe(
      "install_dependency"
    )
    expect(classifyCommand("git status; git push origin HEAD")).toBe("git_push")
    expect(classifyCommand("npm test")).toBeNull()
    expect(classifyCommand("bun run build")).toBeNull()
  })

  it("unwraps shells and wrappers before matching git push", () => {
    expect(classifyCommand("env git push")).toBe("git_push")
    expect(classifyCommand("command git push origin HEAD")).toBe("git_push")
    expect(classifyCommand("/usr/bin/git push origin HEAD")).toBe("git_push")
    expect(classifyCommand("sudo -u deploy git push")).toBe("git_push")
    expect(classifyCommand("sh -c 'git push origin HEAD'")).toBe("git_push")
    expect(classifyCommand("bash -lc 'cd app && git push'")).toBe("git_push")
    expect(classifyCommand("xargs git push")).toBe("git_push")
  })

  it("gives Claude Code ask or deny rules for installs and always denies git push", () => {
    expect(claudePermissionRules(policy({}))).toMatchObject({
      ask: expect.arrayContaining(["Bash(npm install:*)"]),
      deny: ['Bash','PowerShell','Monitor',"Bash(git push:*)"],
    })
    const denied = claudePermissionRules(policy({ install_dependency: "deny" }))
    expect(denied.ask).toEqual([])
    expect(denied.deny).toEqual(
      expect.arrayContaining(["Bash(git push:*)", "Bash(pnpm add:*)"])
    )
    expect(
      claudePermissionRules(policy({ install_dependency: "allow" }))
    ).toEqual({ allow: [], ask: [], deny: ['Bash','PowerShell','Monitor',"Bash(git push:*)"] })
    expect(claudePermissionRules(policy({install_dependency:'allow',git_push:'allow'}))).toEqual({allow:[],ask:[],deny:['Bash(git push:*)']})
    const settings = claudeSettings(
      {
        allowWrite: ["/work"],
        denyWrite: ["/work/.git"],
        denyRead: ["/home/me/.ssh"],
        allowDomains: ["github.com"],
      },
      policy({ install_dependency: "deny" })
    )
    // The SDK starts the CLI itself, so the run's sandbox is Claude Code's
    // own (ADR 0009), mapped from the same policy the daemon's took.
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: ["/work"],
        denyWrite: ["/work/.git"],
        denyRead: ["/home/me/.ssh"],
      },
      network: { allowedDomains: ["github.com"], strictAllowlist: true },
    })
    expect(settings.permissions?.deny).toContain("Bash(npm install:*)")
  })

  it("leaves the sandbox's network open when the run may reach any host", () => {
    // A bare `*` is not an allow-list entry the sandbox takes; a host no
    // list covers is prompted for, which bypass mode allows.
    const open = claudeSandboxSettings({
      allowWrite: ["/work"],
      allowDomains: ["*"],
    })
    expect(open.network).toBeUndefined()
    expect(open.enabled).toBe(true)
  })

  it("refuses Cursor's install and push commands unless the policy allows installs", () => {
    const request = (command: string) =>
      ({
        sessionId: "s",
        toolCall: { toolCallId: "t", title: command, rawInput: { command } },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
        ],
      }) as Parameters<typeof acpPermissionResponse>[0]
    const chosen = (command: string, p?: RunPolicy) => {
      const { response } = acpPermissionResponse(request(command), p)
      return response.outcome.outcome === "selected"
        ? response.outcome.optionId
        : null
    }
    expect(chosen("touch NOTES.md")).toBe("yes")
    expect(chosen("npm install zod")).toBe("no")
    expect(
      chosen("npm install zod", policy({ install_dependency: "allow" }))
    ).toBe("yes")
    expect(chosen("git push", policy({ git_push: "allow" }))).toBe("no")
  })

  it("tells the agent what it may do", () => {
    const strict = runInstructions(
      "/wt",
      policy({
        network: "deny",
        install_dependency: "deny",
        write_outside_repo: "deny",
      })
    )
    expect(strict).toContain("Network access is turned off")
    expect(strict).toContain("Do not install or add dependencies")
    expect(strict).toContain("Writing outside it is not allowed")
    const defaults = runInstructions("/wt")
    expect(defaults).toContain("limited to the workspace ceiling")
    expect(defaults).toContain("wait for a host approval")
    expect(defaults).toContain("Native shell execution is unavailable")
  })
  it('does not expose a raw native shell when any untyped install/push action is restricted', () => {
    for (const install of ['allow','ask','deny'] as const) for (const push of ['allow','ask','deny'] as const) {
      const value=policy({install_dependency:install,git_push:push})
      expect(rawCliShellAvailable(value)).toBe(install==='allow' && push==='allow')
      expect(rawCliShellAvailable({...value,readOnly:true})).toBe(false)
    }
  })
})
