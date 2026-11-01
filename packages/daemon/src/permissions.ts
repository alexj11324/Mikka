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

import { decisionFallback } from "./decision-judgments"

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

/**
 * `decide`, with the Decisions API in place of the fixed `ask` for an action
 * the person set nothing for: an unknown action, or a setup recipe nobody
 * approved. A read-only run still denies, and an approved recipe or a
 * configured action never asks. No answer keeps the previous decision (ask).
 */
export async function decideWithJudgment(
  action: string,
  context: PermissionContext,
  judge: (evidence: { action: string; subject?: string }) => Promise<"allow" | "ask" | null>,
  subject?: string
): Promise<PermissionDecision> {
  const fixed = decide(action, context)
  const unknown = !Object.hasOwn(PERMISSION_DEFAULTS, action)
  const unapprovedRecipe = action === "run_setup_recipe" && !context.setupRecipeApproved
  if (fixed === "deny" || !(unknown || unapprovedRecipe)) return fixed
  const judged = await judge({ action, subject })
  if (judged) return judged
  // No answer: what this point did before the Decisions API (ask), never a looser default.
  decisionFallback(`${action} kept its previous decision (${fixed}) without a judgment`)
  return fixed
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
 * Whether the daemon pushes a verified run branch. The server decides push
 * authority at admission (the GitHub App grant, decision 2026-11-01-1215) and
 * sends `allow` in this run's assignment only for an admitted run; anything
 * else does not push and never asks.
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
  return { push: false, note: "Push needs the Mikka GitHub App's access on this repository" }
}

/** Shell commands that add or install dependencies (first word, verb), named
 * only in Claude Code's own CLI rules below; Cursor's commands are judged. */
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
 * The hard-boundary action a shell command line falls under, for CLIs that
 * ask before running a command (Cursor): only `git push`, which the daemon
 * owns (ADR 0017). Every other command is judged by the Decisions API
 * (`judgeCommandAction`), never by a list here. Each `&&`, `;` or `|` segment counts.
 * Wrappers (`sudo`, `env`, `command`, `xargs`, `sh -c …`) are unwrapped so
 * `env git push` and `/usr/bin/git push` cannot slip past the git rule.
 */
export function classifyCommand(command: string, legacy = false): PermissionAction | null {
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const action = classifySegment(segment, 0, legacy)
    if (action) return action
  }
  return null
}

const WRAPPERS = new Set(["sudo", "command", "exec", "env", "nohup", "time", "nice", "xargs"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"])
/** Wrapper options that take the next word as their value (`sudo -u deploy`). */
const OPTION_VALUES = new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-I", "-S"])

function classifySegment(segment: string, depth: number, legacy: boolean): PermissionAction | null {
  const words = segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^['"]+|['"]+$/g, ""))
  // Skip env assignments and wrappers (`FOO=1 npx …`, `sudo -u x …`).
  while (words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift()
      continue
    }
    if (WRAPPERS.has(basename(words[0]))) {
      words.shift()
      while (words.length && words[0].startsWith("-")) {
        const option = words.shift() as string
        if (!option.includes("=") && OPTION_VALUES.has(option)) words.shift()
      }
      continue
    }
    break
  }
  const [tool] = words
  if (!tool) return null
  const name = basename(tool)
  // `sh -c "git push"` keeps the real command in the argument string.
  if (SHELLS.has(name) && depth < 3) {
    const index = words.findIndex((word) => word === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
    if (index !== -1) {
      const nested = words.slice(index + 1).join(" ").replace(/^['"]|['"]$/g, "")
      const action = classifyCommand(nested, legacy)
      if (action) return action
    }
  }
  if (name === "git" && words.slice(1).some((word) => word === "push")) return "git_push"
  // Only when the Decisions API gave no answer: the classification in force before it, so a fallback never loosens anything.
  if (legacy) {
    const entry = INSTALL_COMMANDS.find(([command]) => command === name)
    if (entry && words[1] && entry[1].includes(words[1])) return "install_dependency"
  }
  return null
}

/**
 * Claude Code permission rules for the run (`--settings` `permissions`).
 * The SDK handles asks through the run-bound host gate. A raw shell whose
 * configurable effects cannot be authorized is unavailable as a capability.
 * `git push` is denied to the agent (the daemon pushes, ADR 0017) unless the
 * agent delivers the run itself with run-scoped GitHub credentials.
 */
export function claudePermissionRules(policy: RunPolicy, agentDelivers = false): {
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
  return {
    allow: [],
    ask: decision === "ask" ? install : [],
    deny: [
      ...(!rawCliShellAvailable(policy) ? ['Bash','PowerShell','Monitor'] : []),
      ...(agentDelivers && !policy.readOnly ? [] : ["Bash(git push:*)"]),
      ...(policy.readOnly ? READ_ONLY_TOOLS : []),
      ...(decision === "deny" ? install : []),
    ],
  }
}

/** Tools that change the worktree, denied to a read-only run (ADR 0046). */
const READ_ONLY_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"]

/** What the agent is told about this run's permissions. */
export function policyInstructions(policy: RunPolicy): string[] {
  const { permissions } = policy
  const lines: string[] = []
  if (policy.readOnly)
    lines.push(
      "- This is a read-only check: you may read the worktree but not change it, and nothing is pushed. Report what you found through `submit`; do not fix anything yourself."
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
