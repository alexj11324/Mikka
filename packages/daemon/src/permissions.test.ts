import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

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
  decideWithJudgment,
  policyInstructions,
  pushDecision,
  runDomains,
  rawCliShellAvailable,
} from "./permissions"
import { judgePermissionDefault } from "./decision-judgments"
import type { ServerDecide } from "./server-decision"

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

  it("asks the Decisions API for unset setup recipes and unknown actions", async () => {
    const answering = (choice: string | null) => vi.fn<ServerDecide>(async () =>
      choice === null ? null : new Map([["decision", { type: "choice" as const, name: "decision", choice }]]))
    const judge = (decideFn: ServerDecide) => (evidence: { action: string; subject?: string }) => judgePermissionDefault(decideFn, "run-1", evidence)
    const ask = answering("ask")
    expect(await decideWithJudgment("run_setup_recipe", {}, judge(ask), "abc123")).toBe("ask")
    expect(ask.mock.calls[0][1]).toMatchObject({ purpose: "setup-recipe" })
    expect(ask.mock.calls[0][1].input).toContain("abc123")
    const allow = answering("allow")
    expect(await decideWithJudgment("format_disk", {}, judge(allow))).toBe("allow")
    expect(allow.mock.calls[0][1]).toMatchObject({ purpose: "permission-default" })
    // An approved recipe, a configured action and a read-only run never ask.
    const unasked = answering("ask")
    expect(await decideWithJudgment("run_setup_recipe", { setupRecipeApproved: true }, judge(unasked))).toBe("allow")
    expect(await decideWithJudgment("git_push", { policy: policy({ git_push: "deny" }) }, judge(unasked))).toBe("deny")
    expect(await decideWithJudgment("format_disk", { policy: { ...policy({}), readOnly: true } }, judge(unasked))).toBe("deny")
    expect(unasked).not.toHaveBeenCalled()
    // No answer: the decision this point had before the Decisions API (ask), never allow.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await decideWithJudgment("format_disk", {}, judge(answering(null)))).toBe("ask")
      expect(await decideWithJudgment("run_setup_recipe", {}, judge(answering(null)))).toBe("ask")
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Decision fallback: /))
    } finally {
      warn.mockRestore()
    }
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
    expect(decide("git_push", { policy: p })).toBe("deny")
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
        "Bash(git push:*)",
        "Write",
        "Edit",
        "Bash(npm install:*)",
      ]),
    })
    expect(policyInstructions(p)[0]).toContain("read-only check")
    // A read-only check never pushes, even when handed GitHub delivery.
    expect(claudePermissionRules(p, true).deny).toContain("Bash(git push:*)")
  })

  it("lets the agent push only when it delivers the run itself", () => {
    // The daemon pushes (ADR 0017): every other run denies the agent's push.
    expect(claudePermissionRules(policy({ git_push: "allow" })).deny).toContain("Bash(git push:*)")
    // A GitHub delivery run: the server sent run-scoped credentials because
    // the push is allowed, and the agent is told to push and open the PR.
    expect(claudePermissionRules(policy({ git_push: "allow" }), true).deny).not.toContain("Bash(git push:*)")
  })

  it("detects only git push in code; installs are judged by the Decisions API", () => {
    expect(classifyCommand("npm install left-pad")).toBeNull()
    expect(classifyCommand("cd web && pnpm add zod")).toBeNull()
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

  it("gives Claude Code ask or deny rules for explicit install restrictions and always denies git push", () => {
    expect(claudePermissionRules(policy({install_dependency: "ask"}))).toMatchObject({
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
    ).toEqual({ allow: [], ask: [], deny: ["Bash(git push:*)"] })
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

  it("applies the policy for the action the Decisions API names for a Cursor command", async () => {
    const request = (command: string) =>
      ({
        sessionId: "s",
        toolCall: { toolCallId: "t", title: command, rawInput: { command } },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" },
          { optionId: "yes", name: "Allow", kind: "allow_once" },
        ],
      }) as Parameters<typeof acpPermissionResponse>[0]
    const answering = (choice: string | null) => vi.fn<ServerDecide>(async () =>
      choice === null ? null : new Map([["action", { type: "choice" as const, name: "action", choice }]]))
    const chosen = async (command: string, p?: RunPolicy, decideFn: ServerDecide = answering(null), cache = new Map()) => {
      const { response } = await acpPermissionResponse(request(command), p, false, { decide: decideFn, runId: "run-1", cwd: "/wt", cache })
      return response.outcome.outcome === "selected"
        ? response.outcome.optionId
        : null
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      // The person's settings give every action the same answer: nothing is asked.
      const unasked = answering("install_dependency")
      expect(await chosen("npm install zod", undefined, unasked)).toBe("yes")
      expect(await chosen("npm install zod", policy({ install_dependency: "allow" }), unasked)).toBe("yes")
      expect(unasked).not.toHaveBeenCalled()
      // A restricted install setting: the judged action's policy applies.
      const denied = policy({ install_dependency: "deny" })
      const install = answering("install_dependency")
      expect(await chosen("npm install zod", denied, install)).toBe("no")
      expect(install).toHaveBeenCalledWith("run-1", expect.objectContaining({ purpose: "command-action" }), undefined)
      expect(install.mock.calls[0][1].input).toContain("npm install zod")
      expect(await chosen("npm test", denied, answering("run_project_script"))).toBe("yes")
      expect(await chosen("touch NOTES.md", denied, answering("other"))).toBe("yes")
      // Answers are cached per run by command digest.
      const cache = new Map()
      const once = answering("install_dependency")
      await chosen("pip install x", denied, once, cache)
      await chosen("pip install x", denied, once, cache)
      expect(once).toHaveBeenCalledTimes(1)
      // No answer: the decision the command had before the Decisions API, never looser.
      warn.mockClear()
      expect(await chosen("npm install zod", denied, answering(null))).toBe("no")
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Decision fallback: /))
      expect(await chosen("npm test", denied, answering(null))).toBe("yes")
      // git push stays a hard deny, never asked.
      const push = answering("other")
      expect(await chosen("git push", policy({ git_push: "allow" }), push)).toBe("no")
      expect(await chosen("git push", denied, push)).toBe("no")
      expect(push).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    // Agent-delivered GitHub runs push themselves, still within the policy.
    const delivered = async (command: string, p?: RunPolicy) => {
      const { response } = await acpPermissionResponse(request(command), p, true)
      return response.outcome.outcome === "selected" ? response.outcome.optionId : null
    }
    expect(await delivered("git push https://github.com/o/r.git HEAD:refs/heads/mikka/x", policy({ git_push: "allow" }))).toBe("yes")
    expect(await delivered("git push", policy({ git_push: "deny" }))).toBe("no")
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
