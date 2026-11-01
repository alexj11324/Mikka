// Agent permissions and guidance (ADR 0009, ADR 0028). One table shared by
// the server (which stores the workspace's choices and sends them with every
// run), the desktop app (设置 › 功能 › Agents) and the daemon (which applies
// them in the sandbox, the CLIs' own permission rules and its own push).
//
// Some actions are hard rules, never configurable: the run's worktree is the
// agent's to read and write, project scripts run there, and a repo has to be
// on the device's allow-list before anything starts. The rest default to
// their scoped defaults; a workspace owner or admin may change them within the choices
// listed for each action.
import { z } from "zod"
import { networkDomainsWithin } from "./network-bounds"
export { intersectNetworkDomains, networkDomainsWithin } from "./network-bounds"

export const PERMISSION_ACTIONS = [
  "read_in_worktree",
  "write_in_worktree",
  "run_project_script",
  "run_setup_recipe",
  "install_dependency",
  "write_outside_repo",
  "git_push",
  "network",
  "computer_use",
] as const
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export const PERMISSION_DECISIONS = ["allow", "ask", "deny"] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** Actions a workspace may set, each with the decisions it may pick. */
export const CONFIGURABLE_PERMISSIONS = {
  install_dependency: ["allow", "ask", "deny"],
  // Everything outside the worktree is read-only in the sandbox (ADR 0009,
  // Stage 1 isolation), so writing there cannot be allowed wholesale.
  write_outside_repo: ["ask", "deny"],
  git_push: ["allow", "ask", "deny"],
  network: ["allow", "ask", "deny"],
  computer_use: ["allow", "ask", "deny"],
} as const satisfies Partial<
  Record<PermissionAction, readonly PermissionDecision[]>
>
export type ConfigurableAction = keyof typeof CONFIGURABLE_PERMISSIONS
export const CONFIGURABLE_ACTIONS = Object.keys(
  CONFIGURABLE_PERMISSIONS
) as ConfigurableAction[]

/** Hard rules: shown read-only, never stored. */
export const FIXED_PERMISSIONS = {
  read_in_worktree: "allow",
  write_in_worktree: "allow",
  run_project_script: "allow",
  // Allowed once the user approved the repo's recipe; asked before that.
  run_setup_recipe: "allow",
} as const satisfies Partial<Record<PermissionAction, PermissionDecision>>
export type FixedAction = keyof typeof FIXED_PERMISSIONS

export const PERMISSION_DEFAULTS: Readonly<
  Record<PermissionAction, PermissionDecision>
> = {
  ...FIXED_PERMISSIONS,
  install_dependency: "allow",
  write_outside_repo: "ask",
  git_push: "ask",
  // Agents reach the open internet unless a person restricts it in settings
  // (decision 2026-11-01-1230-network-open-by-default).
  network: "allow",
  computer_use: "ask",
}

export function isConfigurableAction(
  action: string
): action is ConfigurableAction {
  return Object.hasOwn(CONFIGURABLE_PERMISSIONS, action)
}

/** Whether `decision` is one of the choices the action offers. */
export function permissionChoiceAllowed(
  action: ConfigurableAction,
  decision: string
): decision is PermissionDecision {
  return (CONFIGURABLE_PERMISSIONS[action] as readonly string[]).includes(
    decision
  )
}

/**
 * A domain the sandbox proxy matches: `host`, `*.host`, optionally with a
 * `:port`. A bare `*` is not a domain; choosing "allow" for network access
 * is how a workspace opens everything.
 */
export const NETWORK_DOMAIN_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/

export const MAX_NETWORK_DOMAINS = 200
export const MAX_GUIDANCE_LENGTH = 10_000
export const MAX_MODEL_NAME_LENGTH = 120

export const networkDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(NETWORK_DOMAIN_RE)

/** Lower-cased, trimmed and de-duplicated, in the order given. */
export function normalizeDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(
    Boolean
  )
}

export const networkAllowSchema = z
  .array(networkDomainSchema)
  .max(MAX_NETWORK_DOMAINS)
  .transform(normalizeDomains)

/** Stored permission choices (`agent_settings.permissions`), all optional. */
export const storedPermissionsSchema = z
  .strictObject({
    install_dependency: z.enum(CONFIGURABLE_PERMISSIONS.install_dependency),
    write_outside_repo: z.enum(CONFIGURABLE_PERMISSIONS.write_outside_repo),
    git_push: z.enum(CONFIGURABLE_PERMISSIONS.git_push),
    network: z.enum(CONFIGURABLE_PERMISSIONS.network),
    computer_use: z.enum(CONFIGURABLE_PERMISSIONS.computer_use),
  })
  .partial()
export type StoredPermissions = z.infer<typeof storedPermissionsSchema>

export const guidanceSchema = z.string().max(MAX_GUIDANCE_LENGTH)

/**
 * The workspace's default network allow-list when it has set none (ADR
 * 0009: "workspace default, for example npm, GitHub"). Package registries
 * come with "install dependencies: allow", not with this list.
 */
export const DEFAULT_NETWORK_ALLOW: readonly string[] = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
]

/** Reachable when installing dependencies is allowed. */
export const PACKAGE_REGISTRY_DOMAINS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
]

/**
 * Actions a read-only run (ADR 0046: the acceptance check) may never take,
 * whatever the workspace chose. Reading the worktree is all it does; it
 * reports what it found through its submit and changes nothing.
 */
export const READ_ONLY_DENIED: readonly PermissionAction[] = [
  "write_in_worktree",
  "write_outside_repo",
  "run_project_script",
  "run_setup_recipe",
  "install_dependency",
  "git_push",
  "computer_use",
]

/** What a run is sent (`RunAssignment.policy`): every choice filled in. */
export const runPolicySchema = z.strictObject({
  permissions: z.strictObject({
    install_dependency: z.enum(PERMISSION_DECISIONS),
    write_outside_repo: z.enum(PERMISSION_DECISIONS),
    git_push: z.enum(PERMISSION_DECISIONS),
    network: z.enum(PERMISSION_DECISIONS),
    // Older servers omit this field; the daemon treats that as ask, never allow.
    computer_use: z.enum(PERMISSION_DECISIONS).optional(),
  }),
  /** The workspace layer of the domain allow-list (ADR 0009). */
  networkAllow: z.array(z.string().min(1).max(253)).max(MAX_NETWORK_DOMAINS),
  /** Host-derived worker/workspace ceiling; even network=allow cannot widen it. */
  networkCeiling: z.array(networkDomainSchema).max(MAX_NETWORK_DOMAINS).optional(),
  /**
   * The run only reads: the worktree is not writable and nothing is pushed
   * (ADR 0046). Absent from an older server means a normal, writable run.
   */
  readOnly: z.boolean().optional(),
})
export type RunPolicy = z.infer<typeof runPolicySchema>
export type RunPermissions = RunPolicy["permissions"]

/**
 * The harnesses a person may pick a model for. The mock has none: it replays
 * a fixture and never calls a model API.
 */
export const MODEL_HARNESSES = ["claude_code", "codex", "cursor"] as const
export type ModelHarness = (typeof MODEL_HARNESSES)[number]

export const modelHarnessSchema = z.enum(MODEL_HARNESSES)

export function isModelHarness(harness: string): harness is ModelHarness {
  return (MODEL_HARNESSES as readonly string[]).includes(harness)
}

/**
 * One model name as the harness's own CLI takes it (`sonnet`,
 * `claude-sonnet-4-5`, `gpt-5-codex`). It reaches the CLI as a single argv
 * entry, never through a shell, so the only rule is that it is short and not
 * blank; Mikka keeps no list of what each vendor ships.
 */
export const modelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MODEL_NAME_LENGTH)

/** A person's model per harness; a harness left out uses the CLI's default. */
export const modelByHarnessSchema = z
  .strictObject({
    claude_code: modelNameSchema,
    codex: modelNameSchema,
    cursor: modelNameSchema,
  })
  .partial()
export type ModelByHarness = z.infer<typeof modelByHarnessSchema>

/**
 * The stored `model_by_harness` jsonb narrowed to what the schema accepts: a
 * row written by an older build may hold anything, so each entry is checked
 * on its own and a bad one is dropped rather than taking the good ones with
 * it. Unknown harnesses are never read back.
 */
export function resolveModelByHarness(stored: unknown): ModelByHarness {
  const record =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {}
  const out: ModelByHarness = {}
  for (const harness of MODEL_HARNESSES) {
    const parsed = modelNameSchema.safeParse(record[harness])
    if (parsed.success) out[harness] = parsed.data
  }
  return out
}

/** The model a run on `harness` was asked to use; null means the CLI's own. */
export function modelForHarness(
  stored: unknown,
  harness: string
): string | null {
  if (!isModelHarness(harness)) return null
  return resolveModelByHarness(stored)[harness] ?? null
}

/**
 * How much a person lets their own runs do without asking (设置 › Agent
 * personalization). ADR 0009 sets the workspace's choices and defaults the
 * four configurable actions to Ask; a personal mode may only make a run
 * stricter than that, never looser:
 *
 * - `ask`: the workspace's policy, unchanged. The default.
 * - `read_only`: the run reads and reports but changes nothing — the policy
 *   the read-only acceptance check already gets (ADR 0046), applied to every
 *   run this person's work goes through.
 */
export const APPROVAL_MODES = ["ask", "read_only"] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export const approvalModeSchema = z.enum(APPROVAL_MODES)

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === "string" &&
    (APPROVAL_MODES as readonly string[]).includes(value)
  )
}

/** The stored mode, or `ask` for anything a row should not have held. */
export function resolveApprovalMode(stored: unknown): ApprovalMode {
  return isApprovalMode(stored) ? stored : "ask"
}

/** Most permissive first: a stricter decision has the lower number. */
const DECISION_RANK: Record<PermissionDecision, number> = {
  allow: 2,
  ask: 1,
  deny: 0,
}

/**
 * A run's policy with a person's approval mode applied. Every branch can only
 * take an action away: `read_only` denies the configurable actions that
 * change something and marks the policy read-only. Network stays as the
 * workspace set it — a read-only run still has to reach its model's API
 * (ADR 0046). Nothing here turns an `ask` into an `allow`.
 */
export function applyApprovalMode(
  policy: RunPolicy,
  mode: ApprovalMode
): RunPolicy {
  if (mode === "ask") return policy
  const permissions = { ...policy.permissions }
  for (const action of CONFIGURABLE_ACTIONS) {
    if (READ_ONLY_DENIED.includes(action)) permissions[action] = "deny"
  }
  return { ...policy, permissions, readOnly: true }
}

/**
 * Whether `next` is no more permissive than `base`, action by action, and
 * keeps a read-only flag. This is the guarantee `applyApprovalMode` makes,
 * spelled out so a test can hold every mode against it.
 */
export function isNoLooserThan(base: RunPolicy, next: RunPolicy): boolean {
  if (base.networkCeiling && (!next.networkCeiling || !networkDomainsWithin(next.networkCeiling, base.networkCeiling))) return false
  if (base.readOnly === true && next.readOnly !== true) return false
  return CONFIGURABLE_ACTIONS.every(
    (action) =>
      DECISION_RANK[next.permissions[action] ?? "ask"] <=
      DECISION_RANK[base.permissions[action] ?? "ask"]
  )
}

/**
 * One person's `user_agent_preference` row as stored (ADR 0060). Personal
 * where `StoredAgentSettings` is shared; every field may be missing, and the
 * resolvers below narrow the raw columns rather than trusting them.
 */
export interface StoredUserAgentPreference {
  instructions?: string | null
  defaultHarness?: string | null
  modelByHarness?: unknown
  approvalMode?: string | null
}

/** The instructions to append to a brief, trimmed; null when there are none. */
export function resolveInstructions(stored: unknown): string | null {
  const text = typeof stored === "string" ? stored.trim() : ""
  return text.length > 0 ? text : null
}

/** The harness a new issue is delegated to by default, or null for none. */
export function resolveDefaultHarness(stored: unknown): ModelHarness | null {
  return typeof stored === "string" && isModelHarness(stored) ? stored : null
}

/** A settings row as stored; null fields inherit (team rows) or default. */
export interface StoredAgentSettings {
  permissions?: unknown
  networkAllow?: unknown
  guidance?: string | null
}

/** Permissions with defaults; an invalid stored choice falls back. */
/** Only the authenticated host selects the execution environment. */
export type ExecutionEnvironment = 'local' | 'cloud'

export function resolvePermissions(stored: unknown, environment: ExecutionEnvironment = 'local'): RunPermissions {
  const out = {} as Record<ConfigurableAction, PermissionDecision>
  const record =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {}
  for (const action of CONFIGURABLE_ACTIONS) {
    const value = record[action]
    out[action] =
      typeof value === "string" && permissionChoiceAllowed(action, value)
        ? value
        : PERMISSION_DEFAULTS[action] as PermissionDecision
  }
  return out
}

export function resolveNetworkAllow(stored: unknown): string[] {
  if (stored === null || stored === undefined) return [...DEFAULT_NETWORK_ALLOW]
  const parsed = networkAllowSchema.safeParse(stored)
  return parsed.success ? parsed.data : [...DEFAULT_NETWORK_ALLOW]
}

export interface ResolvedAgentSettings {
  policy: RunPolicy
  /** Guidance appended to every assignment; null when there is none. */
  guidance: string | null
  /** Where the guidance came from. */
  guidanceFrom: "team" | "workspace" | null
}

/**
 * The settings a run gets: the workspace row (or defaults), with the team's
 * guidance in place of the workspace's when the team set its own. A team's
 * empty guidance means "none for this team"; null inherits.
 */
export function resolveAgentSettings(
  workspace: StoredAgentSettings | null | undefined,
  team?: StoredAgentSettings | null,
  environment: ExecutionEnvironment = 'local'
): ResolvedAgentSettings {
  const permissions = resolvePermissions(workspace?.permissions, environment)
  const explicit = storedPermissionsSchema.safeParse(workspace?.permissions ?? {})
  if (environment === 'cloud' && workspace?.networkAllow != null && explicit.success && explicit.data.network === undefined) permissions.network = 'ask'
  const teamGuidance = team?.guidance
  const workspaceGuidance = workspace?.guidance ?? null
  const fromTeam = teamGuidance !== null && teamGuidance !== undefined
  const text = (fromTeam ? teamGuidance : workspaceGuidance)?.trim() ?? ""
  return {
    policy: {
      permissions,
      networkAllow: resolveNetworkAllow(workspace?.networkAllow),
    },
    guidance: text ? text : null,
    guidanceFrom: text ? (fromTeam ? "team" : "workspace") : null,
  }
}

/** Defaults for a daemon whose server sent no policy (an older server). */
export function defaultRunPolicy(): RunPolicy {
  return resolveAgentSettings(null).policy
}

/** Stable policy input shared by server and daemon execution-evidence hashing. */
export function runPolicyDigestInput(policy?: RunPolicy): string {
  const resolved = runPolicySchema.parse(policy ?? defaultRunPolicy())
  return JSON.stringify(resolved, [...Object.keys(resolved), ...Object.keys(resolved.permissions)].sort())
}
