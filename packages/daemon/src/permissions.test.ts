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
import { claudeSettings } from "./adapters/claude"
import { runInstructions } from "./agents/run-context"
import {
  PERMISSION_DEFAULTS,
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
    ["install_dependency", "allow"],
    ["write_outside_repo", "ask"],
    // Push is what the GitHub App grants: only the server's explicit allow pushes.
    ["git_push", "deny"],
    ["network", "allow"],
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
    // Open by default (decision 2026-11-01-1230); a person's choice still holds.
    expect(decide("network", { policy: p })).toBe("allow")
    expect(decide("network", { policy: policy({ network: "ask" }) })).toBe("ask")
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
    // Unrestricted unless a person chose otherwise.
    expect(runDomains(policy({}), ["npmjs.org"])).toEqual(["*"])
    expect(runDomains(policy({ network: "ask" }), ["npmjs.org"])).toEqual([
      "github.com",
      "npmjs.org",
      ...PACKAGE_REGISTRY_DOMAINS,
    ])
    expect(runDomains(policy({ network: "allow" }), ["npmjs.org"])).toEqual([
      "*",
    ])
    expect(runDomains(policy({ network: "deny" }), ["npmjs.org"])).toEqual([])
    expect(
      runDomains(policy({ network: "deny", install_dependency: "allow" }))
    ).toEqual([])
    expect(runDomains(policy({ network: "ask", install_dependency: "allow" }))).toEqual([
      "github.com",
      ...PACKAGE_REGISTRY_DOMAINS,
    ])
  })

  it("pushes by the workspace's choice and the repo's approval", () => {
    // Only the server's allow (an admitted GitHub App grant) pushes; nothing local stands in for it.
    expect(pushDecision(policy({}))).toEqual({
      push: false,
      note: "Push is turned off for this run",
    })
    expect(pushDecision(policy({ git_push: "allow" }))).toEqual({ push: true })
    expect(pushDecision(policy({ git_push: "deny" }))).toEqual({
      push: false,
      note: "Push is turned off for this run",
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
    // Read-only is task intent: the agent's own push is not withheld.
    expect(decide("git_push", { policy: p })).toBe("allow")
    // Reading is the whole point of the check.
    expect(decide("read_in_worktree", { policy: p })).toBe("allow")
    // A read-only check never pushes, even on an approved repo.
    expect(pushDecision(p)).toEqual({
      push: false,
      note: "A read-only check does not push",
    })
    // The CLI is told the same, and never offered an install.
    expect(claudePermissionRules(p)).toMatchObject({
      ask: [],
      deny: expect.arrayContaining([
        "Write",
        "Edit",
        "Bash(npm install:*)",
      ]),
    })
    expect(policyInstructions(p)[0]).toContain("read-only check")
    expect(claudePermissionRules(p).deny).not.toContain("Bash(git push:*)")
  })

  it("never withholds the agent's own git push: it works with the person's own credential", () => {
    for (const git_push of ["allow", "deny"] as const) {
      expect(claudePermissionRules(policy({ git_push })).deny).not.toContain("Bash(git push:*)")
      expect(claudePermissionRules({ ...policy({ git_push }), readOnly: true }).deny).not.toContain("Bash(git push:*)")
    }
  })

  it("gives Claude Code ask or deny rules for explicit install restrictions", () => {
    expect(claudePermissionRules(policy({install_dependency: "ask"}))).toMatchObject({
      ask: expect.arrayContaining(["Bash(npm install:*)"]),
      deny: ['Bash','PowerShell','Monitor'],
    })
    const denied = claudePermissionRules(policy({ install_dependency: "deny" }))
    expect(denied.ask).toEqual([])
    expect(denied.deny).toEqual(
      expect.arrayContaining(["Bash(pnpm add:*)"])
    )
    expect(
      claudePermissionRules(policy({ install_dependency: "allow" }))
    ).toEqual({ allow: [], ask: [], deny: [] })
    expect(claudePermissionRules(policy({install_dependency:'allow',git_push:'deny'}))).toEqual({allow:[],ask:[],deny:[]})
    const settings = claudeSettings(policy({ install_dependency: "deny" }))
    // Runs use no sandbox (decision 2026-11-01-2335): Claude Code's own stays off.
    expect(settings.sandbox).toEqual({ enabled: false })
    expect(settings.permissions?.deny).toContain("Bash(npm install:*)")
  })

  it("asks about a built-in only when its own policy action asks", () => {
    // What is asked comes from the run's resolved policy, not a mode: an
    // action left at `ask` names the tool that reaches the gate.
    const installAsk = claudePermissionRules(policy({}))
    expect(installAsk.ask).toEqual([])
    // install_dependency: ask names the install commands, never the shell.
    const asking = claudePermissionRules(policy({ install_dependency: "ask" }))
    expect(asking.ask).toEqual(expect.arrayContaining(["Bash(npm install:*)"]))
    expect(asking.deny).not.toContain("Bash")
    // A non-gate action left at `ask` adds no CLI rule: the sandbox and the
    // broker already enforce it, so nothing is routed to the callback.
    // write_outside_repo and computer_use both default to `ask`, so a default
    // run still asks nothing per tool.
    expect(policy({}).permissions.write_outside_repo).toBe("ask")
    expect(policy({}).permissions.computer_use).toBe("ask")
    expect(claudePermissionRules(policy({})).ask).toEqual([])
  })

  it("denies a read-only run's changes and subagents, and says so in its brief", () => {
    const planPolicy = { ...policy({}), readOnly: true }
    const rules = claudePermissionRules(planPolicy)
    expect(rules.deny).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent"]))
    expect(rules.ask).toEqual([])
    expect(claudeSettings(planPolicy).permissions).toEqual(rules)
    expect(policyInstructions(planPolicy)[0]).toContain("read-only check")
    // A writable run's brief says nothing about reading.
    expect(policyInstructions(policy({}))).not.toContainEqual(expect.stringContaining("read-only"))
  })

  it("lets every Cursor tool call go ahead, git push included", async () => {
    const request = (command: string) =>
      ({
        sessionId: "s",
        toolCall: { toolCallId: "t", title: command, rawInput: { command } },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
        ],
      }) as Parameters<typeof acpPermissionResponse>[0]
    const chosen = async (command: string) => {
      const response = await acpPermissionResponse(request(command))
      return response.outcome.outcome === "selected" ? response.outcome.optionId : null
    }
    for (const command of ["npm install zod", "npm test", "touch NOTES.md", "git push", "env git push origin HEAD", "git push https://github.com/o/r.git HEAD:refs/heads/mikka/x"])
      expect(await chosen(command)).toBe("yes")
  })

  it("tells the agent it has the person's own GitHub credential, and how to deliver only when it has a task branch", () => {
    const github = { endpoint: "https://mikka.test/api/runs/github-token", repository: "o/r", runToken: "mkw_x", issueId: "i" }
    const credential = "Git and gh have the person's own GitHub credential"
    const plain = runInstructions("/wt", policy({}), github)
    expect(plain).toContain(credential)
    expect(plain).toContain("Never print, copy or store the credential")
    expect(plain).not.toContain("You own delivery")
    expect(plain).not.toContain("Do not commit, push")
    const delivering = runInstructions("/wt", policy({}), { ...github, branch: "mikka/t-1" }, "implement")
    expect(delivering).toContain(credential)
    expect(delivering).toContain("push HEAD to mikka/t-1")
    for (const other of [runInstructions("/wt", { ...policy({}), readOnly: true }, { ...github, branch: "mikka/t-1" }), runInstructions("/wt", policy({}), { ...github, branch: "mikka/t-1" }, "plan")]) {
      expect(other).toContain(credential)
      expect(other).not.toContain("You own delivery")
    }
    expect(runInstructions("/wt", policy({}))).toContain("Do not commit, push or switch branches")
    expect(delivering).not.toContain("mkw_x")
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
    expect(defaults).toContain("Network access is open")
    expect(defaults).not.toContain("Native shell execution is unavailable")
    const asked = runInstructions("/wt", policy({ network: "ask" }))
    expect(asked).toContain("limited to the workspace ceiling")
    expect(asked).toContain("pre-authorized")
  })
  it('keeps project shell execution independent of daemon publication permission', () => {
    for (const install of ['allow','ask','deny'] as const) for (const push of ['allow','deny'] as const) {
      const value=policy({install_dependency:install,git_push:push})
      expect(rawCliShellAvailable(value)).toBe(install==='allow')
      expect(rawCliShellAvailable({...value,readOnly:true})).toBe(false)
    }
  })
})
