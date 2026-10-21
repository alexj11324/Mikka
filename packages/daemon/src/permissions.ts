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
  PACKAGE_REGISTRY_DOMAINS,
  PERMISSION_ACTIONS,
  PERMISSION_DEFAULTS,
  READ_ONLY_DENIED,
  isConfigurableAction,
  type PermissionAction,
  type PermissionDecision,
  type RunPolicy,
} from "@mikka/protocol/agent-policy"

export { PERMISSION_ACTIONS, PERMISSION_DEFAULTS }
export type { PermissionAction, PermissionDecision, RunPolicy }

export interface PermissionContext {
  /** Whether the user approved this repo's setup recipe. */
  setupRecipeApproved?: boolean
  /** The workspace's choices; the ADR 0009 defaults when absent. */
  policy?: RunPolicy
}

export function decide(
  action: string,
  context: PermissionContext = {}
): PermissionDecision {
  if (!Object.hasOwn(PERMISSION_DEFAULTS, action)) return "ask"
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

/**
 * Domains a run may reach on top of its harness's model API (which is
 * always reachable). `allow` opens every host; `deny` keeps only the
 * package registries when installs are allowed; `ask` is the workspace's
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
  if (policy.permissions.network === "allow") return ["*"]
  if (policy.permissions.network === "deny") return [...registries]
  return [...new Set([...policy.networkAllow, ...repoAllow, ...registries])]
}

/**
 * Whether the daemon pushes a verified run branch. `ask` pushes only when
 * the repo was approved ("always for this repo"); `allow` is that approval
 * for every repo; `deny` never pushes.
 */
export function pushDecision(
  policy: RunPolicy,
  repoApproved: boolean
): { push: boolean; note?: string } {
  // A read-only check (ADR 0046) never pushes: it exists to look at what the
  // implementation run already pushed, not to add to it.
  if (policy.readOnly)
    return { push: false, note: "A read-only check does not push" }
  const decision = policy.permissions.git_push
  if (decision === "deny")
    return { push: false, note: "Push is turned off for this workspace" }
  if (decision === "allow" || repoApproved) return { push: true }
  return { push: false, note: "Push needs approval for this repo" }
}

/** Shell commands that add or install dependencies (first word, verb). */
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
 * The policy action a shell command line falls under, for CLIs that ask
 * before running a command (Cursor). Each `&&`, `;` or `|` segment counts.
 * Wrappers (`sudo`, `env`, `command`, `xargs`, `sh -c …`) are unwrapped so
 * `env git push` and `/usr/bin/git push` cannot slip past the git rule.
 */
export function classifyCommand(command: string): PermissionAction | null {
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const action = classifySegment(segment, 0)
    if (action) return action
  }
  return null
}

const WRAPPERS = new Set(["sudo", "command", "exec", "env", "nohup", "time", "nice", "xargs"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"])
/** Wrapper options that take the next word as their value (`sudo -u deploy`). */
const OPTION_VALUES = new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-I", "-S"])

function classifySegment(segment: string, depth: number): PermissionAction | null {
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
  const [tool, verb] = words
  if (!tool) return null
  const name = basename(tool)
  // `sh -c "git push"` keeps the real command in the argument string.
  if (SHELLS.has(name) && depth < 3) {
    const index = words.findIndex((word) => word === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
    if (index !== -1) {
      const nested = words.slice(index + 1).join(" ").replace(/^['"]|['"]$/g, "")
      const action = classifyCommand(nested)
      if (action) return action
    }
  }
  if (name === "git" && words.slice(1).some((word) => word === "push")) return "git_push"
  const entry = INSTALL_COMMANDS.find(([command]) => command === name)
  if (entry && verb && entry[1].includes(verb)) return "install_dependency"
  return null
}

/**
 * Claude Code permission rules for the run (`--settings` `permissions`).
 * Rules apply in bypass mode too; in print mode an `ask` rule has nobody to
 * ask, so the call is refused and the agent is told to call `ask_human`.
 * `git push` is always denied to the agent: the daemon pushes (ADR 0017).
 */
export function claudePermissionRules(policy: RunPolicy): {
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
      "Bash(git push:*)",
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
  lines.push(
    permissions.network === "allow"
      ? "- Network access is open for this workspace."
      : permissions.network === "deny"
        ? "- Network access is turned off (only your model API is reachable). Do not try to reach other hosts."
        : "- Network access is limited to an allow-list. If a request is blocked, do not try to work around it; call `ask_human` if you need it."
  )
  lines.push(
    permissions.install_dependency === "allow"
      ? "- You may install or add dependencies when the task needs them."
      : permissions.install_dependency === "deny"
        ? "- Do not install or add dependencies; this workspace does not allow it. Work with what is installed, or call `report_blocked`."
        : "- Installing or adding dependencies needs a person's approval: call `ask_human` with what you need and why instead of installing it."
  )
  lines.push(
    permissions.write_outside_repo === "deny"
      ? "- Work only inside that worktree. Writing outside it is not allowed."
      : "- Work only inside that worktree. Everything outside it is read-only; if you need to change something there, call `ask_human`."
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
