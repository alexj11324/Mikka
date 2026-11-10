// Agent permissions as data (ADR 0009, ADR 0028). The table and its
// defaults live in packages/protocol (`agent-policy`), shared with the server
// and the app; the workspace's choices arrive with each run's assignment
// (`RunAssignment.policy`). This file applies them: the decision for one
// action, the domains a run may reach, whether the daemon pushes, the rules
// a CLI that has its own permission model is given, and the lines that tell
// the agent what it may do. Anything not listed is `ask`.
import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

import {
  defaultRunPolicy,
  intersectNetworkDomains,
  PACKAGE_REGISTRY_DOMAINS,
  PERMISSION_ACTIONS,
  PERMISSION_DEFAULTS,
  READ_ONLY_DENIED,
  isConfigurableAction,
  type PermissionAction,
  type PermissionDecision,
  type RunPolicy,
} from "@mikka/protocol/agent-policy"
import { threadModeInstructions, type ThreadMode } from "@mikka/protocol/thread-mode"


export { PERMISSION_ACTIONS, PERMISSION_DEFAULTS }
export type { PermissionAction, PermissionDecision, RunPolicy }

export interface PermissionContext {
  /** Whether the user approved this repo's setup recipe. */
  setupRecipeApproved?: boolean
  /** Trusted host assignment only, never model-supplied. Defaults when absent. */
  policy?: RunPolicy
}

export function decide(
  action: string,
  context: PermissionContext = {}
): PermissionDecision {
  if (!Object.hasOwn(PERMISSION_DEFAULTS, action))
    return context.policy?.readOnly ? "deny" : "ask"
  const typed = action as PermissionAction
  // A read-only run (ADR 0046) changes nothing, whatever the workspace chose:
  // the check reads the worktree, reports, and stops.
  if (context.policy?.readOnly && READ_ONLY_DENIED.includes(typed))
    return "deny"
  if (typed === "run_setup_recipe" && !context.setupRecipeApproved) return "ask"
  if (context.policy && isConfigurableAction(typed)) {
    return context.policy.permissions[typed] ?? "ask"
  }
  return PERMISSION_DEFAULTS[typed]
}

/** The policy a run applies: what the server sent, or the defaults. */
export function runPolicy(sent: RunPolicy | undefined): RunPolicy {
  return sent ?? defaultRunPolicy()
}

/** Project commands run inside the host-enforced sandbox. Publishing is a
 * separate daemon capability, never a prerequisite for building or testing.
 * An explicitly restricted installation profile retains file-only execution;
 * unconfigured sandbox work allows project dependencies. */
export function rawCliShellAvailable(policy: RunPolicy): boolean {
  return !policy.readOnly && policy.permissions.install_dependency === 'allow'
}

/**
 * Domains a run may reach on top of its harness's model API (which is
 * always reachable). `allow` opens every host; `deny` closes non-model hosts
 * even when installs are allowed; `ask` is the workspace's
 * and the repo's lists, and any other host goes to the sandbox's ask
 * callback (denied until approval cards exist).
 */
export function runDomains(
  policy: RunPolicy,
  repoAllow: readonly string[] = []
): string[] {
  const registries =
    policy.permissions.install_dependency === "allow"
      ? PACKAGE_REGISTRY_DOMAINS
      : []
  if (policy.permissions.network === "deny") return []
  const destinations = policy.permissions.network === "allow" ? ["*"]
    : [...new Set([...policy.networkAllow, ...repoAllow, ...registries])]
  return policy.networkCeiling === undefined ? destinations : intersectNetworkDomains(destinations, policy.networkCeiling)
}

/**
 * Whether the daemon itself pushes a verified run branch, for a run whose agent
 * does not deliver it: the server sends `allow` for a run with a task branch.
 * The agent's own push is never withheld (decision 2026-11-02-1600).
 */
export function pushDecision(policy: RunPolicy): { push: boolean; note?: string } {
  // A read-only check (ADR 0046) never pushes: it exists to look at what the
  // implementation run already pushed, not to add to it.
  if (policy.readOnly)
    return { push: false, note: "A read-only check does not push" }
  const decision = policy.permissions.git_push
  if (decision === "allow") return { push: true }
  if (decision === "deny")
    return { push: false, note: "Push is turned off for this run" }
  return { push: false, note: "This run has no task branch to push" }
}

/** Shell commands that add or install dependencies (first word, verb), named
 * only in Claude Code's own CLI rules below. */
const INSTALL_COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ["npm", ["install", "i", "add", "ci"]],
  ["pnpm", ["install", "i", "add"]],
  ["yarn", ["install", "add"]],
  ["bun", ["install", "i", "add"]],
  ["pip", ["install"]],
  ["pip3", ["install"]],
  ["uv", ["add", "pip"]],
  ["poetry", ["add", "install"]],
  ["cargo", ["add", "install"]],
  ["go", ["get", "install"]],
  ["gem", ["install"]],
  ["brew", ["install"]],
]

/**
 * Claude Code permission rules for the run (`--settings` `permissions`).
 * The SDK handles asks through the run-bound host gate. A raw shell whose
 * configurable effects cannot be authorized is unavailable as a capability.
 * `git push` is the agent's own judgment, as with the person's own `gh auth
 * login` (decision 2026-11-02-1600): no rule withholds it.
 */
export function claudePermissionRules(policy: RunPolicy, mode: ThreadMode = 'execute'): {
  allow: string[]
  ask: string[]
  deny: string[]
} {
  const install = INSTALL_COMMANDS.flatMap(([tool, verbs]) =>
    verbs.map((verb) => `Bash(${tool} ${verb}:*)`)
  )
  // A read-only run never installs; the sandbox is the authority on writes,
  // these rules just name the intent to the CLI itself.
  const decision = policy.readOnly
    ? "deny"
    : policy.permissions.install_dependency
  // Ask mode names every risky built-in tool; the adapter's canUseTool gate
  // asks the person for each one. Reads are not listed and run directly.
  const ask = [
    ...(decision === "ask" ? install : []),
    ...(mode === "ask" ? ASK_TOOLS : []),
  ]
  // Plan mode also refuses a subagent that would otherwise inherit the run
  // and could act with its own tool surface.
  const plan = mode === "plan" || policy.readOnly
  return {
    allow: [],
    ask,
    deny: [
      // A policy that withholds the native shell keeps denying it in every
      // mode: Ask only adds oversight, and an approval can never widen the
      // policy the run was admitted with.
      ...(!rawCliShellAvailable(policy) ? ['Bash','PowerShell','Monitor'] : []),
      ...(plan ? READ_ONLY_TOOLS : []),
      ...(plan ? ['Task', 'Agent'] : []),
      ...(decision === "deny" ? install : []),
    ],
  }
}

/** Built-in tools that change the worktree or run a command; Ask mode names
 * them so the harness reaches the run-bound approval gate. */
const ASK_TOOLS = ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent"]

/** Tools that change the worktree, denied to a read-only run (ADR 0046). */
const READ_ONLY_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

/** What the agent is told about this run's permissions. */
export function policyInstructions(policy: RunPolicy, mode: ThreadMode = 'execute'): string[] {
  const { permissions } = policy
  const lines: string[] = []
  lines.push(...threadModeInstructions(mode))
  if (policy.readOnly)
    lines.push(
      "- This is a read-only check: you may read the worktree but not change it. Report what you found through `submit`; do not fix anything yourself."
    )
  if (!rawCliShellAvailable(policy)) lines.push('- Native shell execution is unavailable under the current dependency-installation policy. Use the available file tools; report a blocked operation when a shell is required. A chat response does not grant execution authority.')
  lines.push(
    permissions.network === "allow"
      ? "- Network access is open for this workspace."
      : permissions.network === "deny"
        ? "- Network access is turned off (only your model API is reachable). Do not try to reach other hosts."
        : "- Network access is limited to the workspace ceiling. Destinations within that ceiling are pre-authorized; destinations outside it remain unavailable. Do not work around a blocked request."
  )
  lines.push(
    permissions.install_dependency === "allow"
      ? "- You may install or add dependencies when the task needs them."
      : permissions.install_dependency === "deny"
        ? "- Do not install or add dependencies; this workspace does not allow it. Work with what is installed, or call `report_blocked`."
        : "- Dependency installation is unavailable through the native shell under this policy. Report the blocked operation; do not treat a chat reply as approval."
  )
  lines.push(
    permissions.write_outside_repo === "deny"
      ? "- Work only inside that worktree. Writing outside it is not allowed."
      : "- Work only inside that worktree. Everything outside it remains read-only; a chat reply cannot expand the filesystem boundary."
  )
  return lines
}

/**
 * Where a path really points: symlinks in the deepest existing part are
 * resolved, the not-yet-created rest is appended as is.
 */
function realTarget(path: string): string {
  const missing: string[] = []
  let current = path
  for (let hops = 0; ;) {
    try {
      return join(realpathSync(current), ...[...missing].reverse())
    } catch {
      // A dangling symlink: follow it to where the write would land.
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        if (++hops > 40) return path
        current = resolve(dirname(current), readlinkSync(current))
        continue
      }
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

function inside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Classifies a file write by whether it stays inside the run's worktree,
 * after following symlinks: a link in the worktree that points outside it
 * makes the write `write_outside_repo`.
 */
export function classifyWrite(
  worktree: string,
  target: string
): PermissionAction {
  const root = resolve(worktree)
  const lexical = resolve(root, target)
  const ok =
    inside(root, lexical) && inside(realTarget(root), realTarget(lexical))
  return ok ? "write_in_worktree" : "write_outside_repo"
}
