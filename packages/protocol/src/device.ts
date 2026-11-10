// Daemon <-> server link (ADR 0016): the REST routes a daemon calls on the
// API server, with their request and response schemas. The daemon's
// `HttpServerLink` and the server's `routes/devices.ts` both use these;
// nobody re-declares a shape.
//
// Auth:
//   - device routes (`/v1/devices/...`): the daemon's session from
//     `mikka daemon login` (Better Auth device authorization, RFC 8628),
//     sent as `Authorization: Bearer <session token>`; only the device's
//     owner may call them.
//   - run routes (`/v1/runs/:runId/...`): the same device session; only the
//     owner of the device the run is pinned to may call them. Agents hold no
//     server credential: they hand in to the local daemon, and only the
//     daemon talks to the server.
// Every call carries the client version header (ADR 0011).
//
// Naming (firm): the machine is a `device`; agents are named by `harness`.
import { z } from "zod"
import { workspaceReadCommand } from './coding-workspace'

import { modelNameSchema, runPolicySchema } from "./agent-policy"
import { threadModeSchema } from "./thread-mode"
import { signedPolicySnapshotSchema } from "./policy-snapshot"
import { harnessInfoSchema, harnessSchema } from "./harness"
import { quotaSnapshotSchema } from "./quota"
import { runStopReason, runBenchmarkContext } from "./run"
import { MAX_SKILLS_PER_RUN, runSkillSchema } from "./skill"
import { skillAssignmentReceiptSchema } from './skill-artifact'
import { sanitizeTraceContext } from './trace-context'
import { nativeLeaseSchema } from './subscription'
import { mailboxCatalogueSchema } from './mailbox'
import { taskSecretAccessSchema, taskSecretRenewalSchema } from './task-secrets'

const id = z.string().min(1).max(64)
const isoTime = z.iso.datetime({ offset: true })

/** Static canonical tool metadata, prepared in the existing authorized claim.
 * A schema is not an authorization grant and contains no task data or token. */
export const runDecisionCatalogueSchema = z.object({
  version: z.literal(1),
  tool: z.object({
    name: z.literal('record_decision'),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
    annotations: z.object({ idempotentHint: z.literal(true) }).strict(),
  }).strict(),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 32_768,
  { message: 'Prepared decision catalogue is bounded' })

/**
 * A device counts as online while its last heartbeat is younger than this.
 * The daemon beats every 15 s, so this tolerates three missed beats.
 */
export const DEVICE_ONLINE_WINDOW_MS = 60_000

/** Lease a claim or heartbeat grants a run (ADR 0012). */
export const RUN_LEASE_MS = 90_000

export function isDeviceOnline(
  lastSeenAt: string | number | Date | null | undefined,
  now = Date.now(),
): boolean {
  if (lastSeenAt === null || lastSeenAt === undefined) return false
  const seen =
    lastSeenAt instanceof Date
      ? lastSeenAt.getTime()
      : typeof lastSeenAt === "number"
        ? lastSeenAt
        : Date.parse(lastSeenAt)
  return Number.isFinite(seen) && seen <= now && now - seen <= DEVICE_ONLINE_WINDOW_MS
}

/** "设备 n/m 在线": how many of the user's devices are online. */
export function devicesOnline(
  devices: readonly { lastSeenAt: string | number | Date | null }[],
  now = Date.now(),
): { online: number; total: number } {
  return {
    online: devices.filter((d) => isDeviceOnline(d.lastSeenAt, now)).length,
    total: devices.length,
  }
}

// --- Routes ---------------------------------------------------------------

const seg = encodeURIComponent

export const DEVICE_ROUTES = {
  register: "/v1/devices/register",
  heartbeat: "/v1/devices/:deviceId/heartbeat",
  repos: "/v1/devices/:deviceId/repos",
  pendingRuns: "/v1/devices/:deviceId/runs",
  claim: "/v1/devices/:deviceId/runs/:runId/claim",
  commands: "/v1/devices/:deviceId/commands",
  commandsAck: "/v1/devices/:deviceId/commands/ack",
  runEvents: "/v1/runs/:runId/events",
  runPatch: "/v1/runs/:runId",
  runCheckpoint: "/v1/runs/:runId/checkpoint",
} as const

export const devicePaths = {
  register: () => DEVICE_ROUTES.register,
  heartbeat: (deviceId: string) => `/v1/devices/${seg(deviceId)}/heartbeat`,
  repos: (deviceId: string) => `/v1/devices/${seg(deviceId)}/repos`,
  pendingRuns: (deviceId: string) =>
    `/v1/devices/${seg(deviceId)}/runs?state=queued`,
  claim: (deviceId: string, runId: string) =>
    `/v1/devices/${seg(deviceId)}/runs/${seg(runId)}/claim`,
  commands: (
    deviceId: string,
    waitSeconds: number,
    skipRuns: readonly string[] = [],
    updates?: { daemonLatest: string; skipDeviceCommands?: readonly string[] },
  ) =>
    `/v1/devices/${seg(deviceId)}/commands?wait=${waitSeconds}` +
    (skipRuns.length
      ? `&${COMMANDS_SKIP_PARAM}=${skipRuns.map(seg).join(",")}`
      : "") +
    (updates
      ? `&${COMMANDS_DAEMON_LATEST_PARAM}=${seg(updates.daemonLatest)}` +
        (updates.skipDeviceCommands?.length ? `&${COMMANDS_SKIP_DEVICE_COMMANDS_PARAM}=${updates.skipDeviceCommands.map(seg).join(",")}` : "")
      : ""),
  commandsAck: (deviceId: string) =>
    `/v1/devices/${seg(deviceId)}/commands/ack`,
  gateway: (deviceId: string) => `/v1/devices/${seg(deviceId)}/gateway`,
  runEvents: (runId: string) => `/v1/runs/${seg(runId)}/events`,
  runPatch: (runId: string) => `/v1/runs/${seg(runId)}`,
  runCheckpoint: (runId: string) => `/v1/runs/${seg(runId)}/checkpoint`,
}

// --- Registration ---------------------------------------------------------

/** `POST /v1/devices/register` */
export const deviceComputerCapability = z.object({ installed: z.boolean(), version: z.string().max(100).nullable() }).strict()
/**
 * What this machine can run (2026-10-31, devices are runners): the daemon
 * installs its own pinned harnesses, so this reports their install state,
 * never which agents the person installed.
 */
export const deviceRunnerCapability = z.object({
  os: z.string().max(50),
  arch: z.string().max(50),
  freeDiskBytes: z.number().int().nonnegative().nullable(),
  docker: z.boolean(),
  harnesses: z.array(z.object({
    harness: harnessSchema,
    state: z.enum(["installed", "not_installed", "unsupported"]),
    version: z.string().max(100),
  })).max(20),
})
export type DeviceRunnerCapability = z.infer<typeof deviceRunnerCapability>
export const deviceRegistration = z.object({
  deviceType: z.enum(["laptop", "server"]).optional(),
  name: z.string().trim().min(1).max(200),
  hostname: z.string().max(255).nullable().optional(),
  platform: z.string().max(50),
  arch: z.string().max(50),
  daemonVersion: z.string().max(50),
  protocolVersion: z.number().int(),
  harnesses: z.array(harnessInfoSchema).max(20),
  computerUse: deviceComputerCapability.optional(),
  runner: deviceRunnerCapability.optional(),
  /**
   * This machine's one device id, the same in every workspace (ADR ORV-284).
   * Registering with it in another workspace joins the same device there.
   * An id the server does not know yet becomes the new device's id; another
   * person's id registers a new device.
   */
  deviceId: id.optional(),
  /** Needed only when the user belongs to more than one workspace. */
  workspaceId: z.uuid().optional(),
})
export type DeviceRegistration = z.infer<typeof deviceRegistration>

export const deviceRegistered = z.object({
  deviceId: id,
  workspaceId: z.uuid(),
  /** Where the daemon sends traces of its own operations (docs/operations/tracing.md, "Daemon"). Only a public project token. */
  tracing: z.object({
    endpoint: z.url().max(512),
    projectToken: z.string().regex(/^phc_[A-Za-z0-9_-]{8,128}$/),
    sampleRate: z.number().min(0).max(1),
    environment: z.enum(['production', 'preview', 'dev']).optional(),
  }).optional().catch(undefined),
})
export type DeviceRegistered = z.infer<typeof deviceRegistered>

// --- Heartbeat ------------------------------------------------------------

/** Per-run part of the device heartbeat; the server renews the run's lease. */
export const heartbeatRunSchema = z.object({
  runId: id,
  /** Last tool call, turn boundary or file change (not raw output). */
  lastProgressAt: isoTime,
  /** Opaque third-party capabilities, refreshed only with the existing run lease. */
  secretCapabilities: taskSecretRenewalSchema.optional(),
})
export type HeartbeatRun = z.infer<typeof heartbeatRunSchema>

/**
 * Oldest local daemon the server serves. Older released clients cannot access
 * device business routes or register again, even with a fresh login.
 */
export const MIN_DAEMON_VERSION = '0.0.456'
/** packages/daemon/package.json's version: a daemon run from source (dev, E2E). Releases are 0.0.<run number>. */
export const SOURCE_DAEMON_VERSION = '0.0.1'
const stableVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/)
/** What the server tells a daemon about releases: it updates when idle if `latest` is newer. */
export const daemonVersionsSchema = z.object({ min: stableVersion, latest: stableVersion.optional() })
export type DaemonVersions = z.infer<typeof daemonVersionsSchema>
/** The daemon's last failed automatic update; the old version keeps running. Codes only, never npm output. */
export const daemonUpdateFailureSchema = z.object({ version: stableVersion, code: z.enum(['install_failed', 'restart_failed']), at: isoTime })
export type DaemonUpdateFailure = z.infer<typeof daemonUpdateFailureSchema>

/** `POST /v1/devices/:deviceId/heartbeat` */
export const deviceManagementCommand = z.object({ id: z.uuid(), kind: z.enum(['redetect', 'restart', 'update', 'uninstall']) })
export type DeviceManagementCommand = z.infer<typeof deviceManagementCommand>
export const deviceHeartbeatSchema = z.object({
  completedDeviceCommands: z.array(z.uuid()).max(100).optional(),
  failedDeviceCommands: z.array(z.object({ id: z.uuid(), error: z.string().max(500) })).max(100).optional(),
  harnesses: z.array(harnessInfoSchema).max(20),
  computerUse: deviceComputerCapability.optional(),
  runner: deviceRunnerCapability.optional(),
  deviceType: z.enum(["laptop", "server"]).optional(),
  runs: z.array(heartbeatRunSchema).max(500),
  worktreeDiskBytes: z.number().int().nonnegative(),
  /**
   * Subscription windows read on this device. Absent when the daemon is not
   * polling. Numbers only, never a vendor credential (ADR 0027).
   */
  quotas: z.array(quotaSnapshotSchema).max(6).optional(),
  /** Null once no automatic update has failed since the last success. */
  updateFailure: daemonUpdateFailureSchema.nullable().optional(),
})
export type DeviceHeartbeat = z.input<typeof deviceHeartbeatSchema>

export const heartbeatResultSchema = z.object({
  deviceCommands: z.array(deviceManagementCommand).max(1).optional(),
  /** Renewed lease expiry per run id; a run missing here is not renewed. */
  leases: z.record(z.string(), isoTime),
  /** No plaintext: only grants for current owner/device/run/claim bindings. */
  taskSecrets: z.record(z.string(), taskSecretAccessSchema).optional(),
  /**
   * Runs the device reported that it no longer holds: they ended on the
   * server, or went to another attempt after the lease ran out. The daemon
   * stops them now instead of when their lease runs out.
   */
  revoked: z.array(id).max(500).optional(),
  /** Short-lived cloud device token, returned only over its authenticated link. */
  cloudCredential: z.string().regex(/^orv_[A-Za-z0-9_-]{43}$/).optional(),
  /** A malformed value is dropped, never a failed heartbeat. */
  daemonVersions: daemonVersionsSchema.optional().catch(undefined),
})
export type HeartbeatResult = z.input<typeof heartbeatResultSchema>

/** `GET /v1/devices/:deviceId/gateway`. Null when this server has no gateway. */
export const deviceGatewaySchema = z.object({
  url: z.string().url().nullable(),
  protocol: z.string().regex(/^mikka-ticket-[0-9]+-[a-f0-9]{64}$/).nullable(),
  /** This server wakes the device after every write that can end, pause or
   * revoke one of its runs (stop, lease, credential, policy, membership), so a
   * connected daemon needs no periodic run-control check (#1212). Absent from
   * older servers: the daemon then keeps its one-second check. */
  runControl: z.literal('push').optional(),
  /** This server wakes the device when a person decides a computer review in
   * the web, so a connected daemon syncs pending reviews only on a change or a
   * push, plus a presence refresh (#1212). Absent from older servers: the
   * daemon then keeps syncing every second while a review is pending. */
  computerReviews: z.literal('push').optional(),
  /** This server wakes the device when it writes a native Coordinator tool
   * result, so the waiting tool asks once per push, not every 500 ms. */
  coordinatorResults: z.literal('push').optional(),
})
export type DeviceGatewayTicket = z.infer<typeof deviceGatewaySchema>

// --- Checkpoints ------------------------------------------------------------

/** Largest gzipped checkpoint patch the server keeps. */
export const RUN_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024
/** This daemon enforces requireWorktreeContinuation before starting an agent. */
export const RECOVERY_WORKTREE_HEADER = 'x-mikka-recovery-worktree'
/** Longest an automatic cross-machine recovery uses an uploaded snapshot. */
export const RUN_CHECKPOINT_RECOVERY_MAX_AGE_MS = 30 * 60_000

/**
 * A run's work in progress, saved by the daemon (never the agent) after
 * tool calls and on a timer, so another machine can take the run over when
 * this one goes offline. The server keeps the latest one per run.
 */
export const runCheckpointSchema = z.object({
  /** The commit the run's worktree started from. */
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  /**
   * `git diff --binary` from `baseCommit` to the whole worktree (tracked
   * and untracked files, ignored ones left out, the agent's own commits
   * included), gzipped, base64.
   */
  patch: z.string().max(Math.ceil((RUN_CHECKPOINT_MAX_BYTES * 4) / 3) + 4),
  /** Files the patch touches. */
  files: z.number().int().nonnegative(),
  takenAt: isoTime,
  /** The latest tree could not be checkpointed; it supersedes older patches. */
  unavailableReason: z.literal('too_large').optional(),
  /** Full-source review proof is optional and independently validated. It is
   * consumed in memory, never retained in recovery records or claim payloads. */
  review: z.unknown().optional(),
})
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>

/** The authenticated upload's persisted server time, never the device clock.
 * Older servers return no receipt; that cannot certify a final archive. */
export const runCheckpointReceiptSchema = z.object({
  runId: id,
  takenAt: z.iso.datetime({ precision: 3 }),
}).strict()
export type RunCheckpointReceipt = z.infer<typeof runCheckpointReceiptSchema>

// --- Repository settings ---------------------------------------------------

export const setupRecipeSchema = z.object({
  /** Paths relative to the main checkout copied into each new worktree. */
  copyFiles: z.array(z.string().max(1_000)).max(200),
  /** Shell command run in the worktree, e.g. `bun install`. */
  command: z.string().max(2_000).optional(),
  /** Approved once per repo by the user; unapproved recipes never run. */
  approved: z.boolean(),
})
export type SetupRecipe = z.infer<typeof setupRecipeSchema>

export const REPO_ORIGIN_HEADER = "x-mikka-repo-origin-check"

/** Sent by a daemon that injects `modelCredential`; a run frozen on an API key is handed only to one. */
export const MODEL_CREDENTIAL_HEADER = "x-mikka-model-credential"
/** The daemon accepts credentials prepared in the claim response (#1505). */
export const RUN_CREDENTIALS_HEADER = "x-mikka-run-credentials"
/** Only the first cloud claim can replace that sync's repository discovery. */
export const INITIAL_REPOSITORY_HEADER = "x-mikka-initial-repository"

const credentialKey = z.string().min(1).max(4_096).refine(value => !/[\r\n\0]/.test(value))
/** Background refresh response; null means the provider set no expiry. */
export const runGitHubCredentialSchema = z.object({ token: credentialKey, expiresAt: isoTime.nullable() }).strip()
const credentialBaseUrl = z.url().max(500).refine(value => {
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
})

/**
 * The model credential a run is given at claim (orchestration.md § 6): an
 * API key, or a provider's base URL, protocol and key. The daemon's
 * `RunCredential` (packages/daemon/src/agents/run-credential.ts).
 */
export const runModelCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), key: credentialKey }).strict(),
  z.object({ kind: z.literal("provider"), protocol: z.enum(["anthropic", "openai"]), baseUrl: credentialBaseUrl, key: credentialKey }).strict(),
])
export type RunModelCredential = z.infer<typeof runModelCredentialSchema>

/** A repository record and its identity-scoped settings. */
export const deviceRepoSchema = z.object({
  repoId: id,
  name: z.string().max(500),
  /** Logical repository key; only trusted cloud runtimes use an absolute path. */
  path: z.string().min(1).max(4_000),
  remoteUrl: z.string().max(2_000).nullable().optional(),
  setup: setupRecipeSchema.optional(),
  /** Domains agents may reach in this repo, on top of the harness's own. */
  networkAllow: z.array(z.string().min(1).max(253)).max(200).optional(),
  /** Push run branches after a verified hand-in ("always for this repo"). */
  push: z
    .object({
      approved: z.boolean(),
      remote: z.string().min(1).max(200).optional(),
    })
    .optional(),
})
export type DeviceRepo = z.infer<typeof deviceRepoSchema>

/** `GET /v1/devices/:deviceId/repos` */
export const deviceReposResponse = z.object({
  repos: z.array(deviceRepoSchema),
})

// --- Runs -----------------------------------------------------------------

/** `GET /v1/devices/:deviceId/runs?state=queued` */
export const pendingRunsResponse = z.object({ runIds: z.array(id) })

/**
 * What an agent run is for (ADR 0012, ADR ORV-205). Must match `RUN_KINDS` in
 * packages/db, which owns the column.
 */
export const RUN_KINDS = ["implement", "acceptance", "fix", "plan"] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** `POST /v1/devices/:deviceId/runs/:runId/claim`: what the daemon gets. */
export const runAssignmentSchema = z.object({
  runId: id,
  /** Optional telemetry, never authorization. A malformed carrier cannot prevent a run. */
  traceContext: z.unknown().transform(sanitizeTraceContext).optional(),
  issueId: id,
  deviceId: id,
  repoId: id,
  /** One-shot owner-scoped settings from the claim; unknown data keeps discovery. */
  repo: deviceRepoSchema.optional().catch(undefined),
  /** Clone URL for local runs; hosted computer assignments keep their isolated workspace. */
  remoteUrl: z.string().min(1).max(4_000).optional(),
  /** Absent means origin/HEAD after fetch. */
  baseBranch: z.string().min(1).max(500).optional(),
  expectedRepoRemote: z.string().max(2_000).optional(),
  harness: harnessSchema,
  prompt: z.string().max(100_000),
  /**
   * The model the harness's CLI is asked to run, from the per-harness
   * preference of the person this run works for (ADR 0060). Absent: the
   * CLI's own default. A daemon that does not know the field ignores it
   * (zod strips unknown keys), so this needs no version gate.
   */
  model: modelNameSchema.optional(),
  /** Frozen Profile effort, passed to the native harness unchanged. */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Owner-bound subscription selection; the optional lease below is prepared once at claim. */
  subscriptionBinding: z.object({
    bindingId: z.uuid(), ownerId: z.string().min(1).max(128), workspaceId: z.uuid(),
    consumerId: z.uuid(), route: z.enum(['codex_cli', 'claude_code_cli']),
  }).strict().optional(),
  /** Access credential for the selected subscription. Kept in memory, never journaled. */
  subscriptionLease: nativeLeaseSchema.optional(),
  /**
   * The run's own API key, opened for this claim only. Never with
   * `subscriptionBinding`. The daemon keeps it in memory and hands it only
   * to the run's Agent process or container; it is never journaled.
   */
  modelCredential: runModelCredentialSchema.optional(),
  /** Local host authority comes only from the server's owner-bound Bot run. */
  localComputer: z.object({
    botId: z.uuid(), ownerId: z.string().min(1).max(128), workspaceId: z.uuid(),
    policyVersion: z.number().int().nonnegative().max(2147483647),
    permission: z.enum(['allow', 'ask']),
  }).strict().optional(),
  /** Trusted server assignment; the model cannot choose a Bot or display. */
  computer: z.object({
    botId: z.uuid(), ownerId: z.string().min(1).max(128),
    display: z.string().regex(/^:[1-9][0-9]{0,2}$/),
    policyVersion: z.number().int().nonnegative().max(2147483647),
  }).strict().optional(),
  /**
   * 4e3: the task's explicit user variables (workspace + matching repository secrets/env, NAME -> value).
   * Cloud workers only. Passed into the task container through its own channel, never into the worker's
   * env, and never written to the run journal.
   */
  taskEnv: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(65_536)).optional(),
  /**
   * Names in `taskEnv` that are secrets (kind 'secret'; env vars are not listed). The daemon masks
   * their values (raw + standard base64) in run output before anything is uploaded; the server
   * masks again. Older daemons strip this field and rely on server-side masking only.
   */
  taskSecretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(500).optional(),
  /** Third-party HTTP capabilities. Never persisted in the daemon journal. */
  taskSecrets: taskSecretAccessSchema.optional(),
  /** Mock harness only: fixture name under `packages/daemon/fixtures`. */
  fixture: z.string().max(200).optional(),
  /**
   * The issue's branch (`mikka/<team>-<number>`, ADR 0024): every run of
   * the issue pushes its verified commit here, so one pull request follows
   * the issue across fix rounds. A run that starts a new worktree builds on
   * this branch from the remote when it exists. Without it the daemon
   * pushes the run's own branch.
   */
  pushBranch: z.string().min(1).max(250).optional(),
  /** Run by the daemon in the worktree after the agent submits. */
  verifyCommand: z.string().max(2_000).optional(),
  /** Host-owned Factory check mode; the model cannot grant a check or skip verification. */
  factoryCheck: z.object({ stage: z.enum(['review', 'verify']), inferCommand: z.boolean(), reportOnly: z.boolean() }).strict().optional(),
  factoryExecuteKind: z.enum(['repository', 'report', 'deliverable']).optional(),
  /** Run lease; renewed through the device heartbeat. */
  leaseExpiresAt: isoTime.optional(),
  /**
   * The Mikka MCP server for the agent inside this run: `report`, `ask` and
   * `blocked` reach the person's Coordinator. Send `token` as a bearer token;
   * it stops working when the run ends. Absent: the server could not issue
   * one, and the run goes ahead without it.
   */
  mcp: z.object({
    url: z.url(), token: z.string().min(1).max(200), mailbox: z.literal(true).optional(),
    decisionCatalogue: runDecisionCatalogueSchema.optional(),
    mailboxCatalogue: mailboxCatalogueSchema.optional(),
    /** Apps (Composio toolkits) this run may use through the Mikka server, one MCP entry each. */
    apps: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64).optional(),
  }).optional(),
  /**
   * The run owner's own GitHub credential for git and gh, prepared once at
   * claim. `endpoint` refreshes it only near its natural expiry. Older
   * servers omit the token; the daemon obtains it once during preparation.
   * `repository` is this run's; `branch` is the task's delivery branch.
   */
  github: z.object({
    endpoint: z.url(), repository: z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
    branch: z.string().regex(/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/).optional(),
    token: runGitHubCredentialSchema.shape.token.optional(),
    expiresAt: runGitHubCredentialSchema.shape.expiresAt.optional(),
  }).strict().refine(value => Boolean(value.token) === (value.expiresAt !== undefined), { message: 'A prepared GitHub token includes its natural expiry', path: ['expiresAt'] }).optional(),
  /** Question continuation must not silently open a different session. */
  /**
   * What the orchestrator dispatched this run for (ADR 0023). `plan` writes a
   * spec and proposes a split instead of changing code (ADR ORV-205).
   */
  kind: z.enum(RUN_KINDS).optional(),
  /**
   * The earlier run this one continues (continue, fix, answer, a person's
   * message): the daemon works on in that run's worktree, on this run's
   * branch, so nothing the earlier run left uncommitted is lost.
   */
  continuesRunId: id.optional(),
  /** A same-device retry with no usable snapshot must reuse its real worktree. */
  requireWorktreeContinuation: z.literal(true).optional(),
  /**
   * The latest checkpoint of the attempt this run takes over after its
   * machine went offline. Used only for a new worktree (another machine, or
   * the earlier worktree is gone): it starts at `baseCommit` (the base
   * commit with the patch applied. Missing or unusable recovery data blocks
   * the attempt rather than silently starting again from the base branch.
   */
  resumeFrom: runCheckpointSchema.optional(),
  /**
   * The harness session to continue. A daemon that cannot resume starts a
   * new session with `prompt`, which always carries the full brief.
   */
  resumeSessionId: z.string().max(500).optional(),
  requireSessionResume: z.boolean().optional(),
  preserveQuestionWorktree: z.boolean().optional(),
  questionId: z.uuid().optional(),
  /**
   * What this run adds on top of the brief (a person's message, an answer,
   * a fix request). A resumed session gets only this as its next message;
   * a new session gets `prompt`, which already includes it.
   */
  followUp: z.string().max(100_000).optional(),
  /**
   * The thread's frozen interaction mode (#1730): plan reads only, ask waits
   * for approval per risky step, execute is the policy's normal behavior.
   * Absent from an older server: the daemon applies Execute.
   */
  mode: threadModeSchema.optional(),
  /**
   * The workspace's agent permissions and network allow-list (ADR 0028).
   * Absent from an older server: the daemon applies the ADR 0009 defaults.
   */
  policy: runPolicySchema.optional(),
  /** Trusted server revision for the exact run policy; older servers omit it. */
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Only a trusted server context can make a snapshot required. */
  policySnapshotRequired: z.boolean().optional(),
  policySnapshot: signedPolicySnapshotSchema.optional(),
  /**
   * The skills mounted on this run's agent and still enabled, resolved at
   * claim time the way `policy` is. The daemon inlines them into the agent's
   * brief and writes them under the run's directory. Absent from an older
   * server: the run simply has none.
   */
  skills: z.array(runSkillSchema).max(MAX_SKILLS_PER_RUN).optional(),
  /** Server-minted assignment provenance; does not grant any policy permission. */
  skillReceipt: skillAssignmentReceiptSchema.optional(),
  /** Frozen by the server benchmark ledger; never extracted from model output. */
  benchmark: runBenchmarkContext.optional(),
}).refine(value => !(value.modelCredential && value.subscriptionBinding), { message: "A run has one model credential", path: ["modelCredential"] })
  .refine(value => !value.subscriptionLease || Boolean(value.subscriptionBinding && value.subscriptionBinding.route === value.subscriptionLease.route &&
    (value.harness === 'codex' ? value.subscriptionLease.route === 'codex_cli' : value.harness === 'claude_code' && value.subscriptionLease.route === 'claude_code_cli')),
  { message: 'A subscription lease belongs to the selected harness and binding', path: ['subscriptionLease'] })
export type RunAssignment = z.infer<typeof runAssignmentSchema>

/**
 * Daemon-local run states (`RUN_STATES` in ./daemon) as sent in a patch.
 * The server only takes non-terminal states from patches; a run's end is
 * recorded by `POST /v1/runs/:runId/complete`.
 */
export const runPatchSchema = z.object({
  state: z.enum([
    "queued",
    "preparing",
    "running",
    "waiting_input",
    "finishing",
    "succeeded",
    "stopped",
    "failed",
    "cancelled",
  ]),
  sessionId: z.string().max(500).nullable().optional(),
  worktree: z.string().max(4_000).nullable().optional(),
  error: z.string().max(10_000).nullable().optional(),
  /** Set on every terminal state. */
  stopReason: runStopReason.optional(),
})
export type RunPatch = z.infer<typeof runPatchSchema>

/**
 * `POST /v1/runs/:runId/events`: a batch of the run's AI SDK
 * `UIMessageChunk`s, appended in order. `fromSeq` is the daemon's producer
 * sequence of the first chunk (1-based, per run), so a batch re-sent after
 * a lost response is applied once.
 */
export const runEventBatchSchema = z.object({
  fromSeq: z.number().int().min(1),
  chunks: z
    .array(z.looseObject({ type: z.string() }))
    .min(1)
    .max(1_000),
})
export type RunEventBatchInput = z.infer<typeof runEventBatchSchema>

export const runEventsAccepted = z.object({
  /** Producer seq of the last chunk the server holds for this run. */
  offset: z.string(),
})

// --- Commands for running agents (ADR 0018) --------------------------------

/** Longest a `GET .../commands` long-poll is held open. */
export const COMMANDS_MAX_WAIT_SECONDS = 25

/**
 * Runs the daemon is already acting on (a stop in progress): their commands
 * are left out of the answer, so the long-poll waits for new ones instead of
 * repeating them. Comma-separated run ids, at most `COMMANDS_MAX_SKIP`.
 */
export const COMMANDS_SKIP_PARAM = "skip"
export const COMMANDS_MAX_SKIP = 100
/**
 * The newest daemon release this daemon already knows of (its own version
 * when none). Sending it says the daemon reads `daemonVersions` and
 * `deviceCommands` from this answer: the long-poll then ends as soon as the
 * server knows a newer release, or has a device command outside
 * `COMMANDS_SKIP_DEVICE_COMMANDS_PARAM`.
 */
export const COMMANDS_DAEMON_LATEST_PARAM = "daemonLatest"
/** Device commands the daemon already holds (comma-separated ids), so a held update does not end every poll. */
export const COMMANDS_SKIP_DEVICE_COMMANDS_PARAM = "skipDeviceCommands"
export const COMMANDS_MAX_SKIP_DEVICE_COMMANDS = 10

/**
 * Something a person asked of a run on this device. `input` is a message a
 * person sent in the run's chat (a `message` row, delivered at least once
 * until acked); `stop` repeats until the run has ended.
 */
/** Older daemons reject unknown command kinds; advertise this extension. */
export const MAILBOX_NOTICE_HEADER = 'x-mikka-mailbox-notices'

export const runCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("input"),
    runId: id,
    messageId: z.uuid(),
    text: z.string().min(1).max(100_000),
  }),
  z.object({ kind: z.literal("stop"), runId: id }),
  // A host notification carries addresses only; peer content remains behind
  // the authenticated mailbox read and retains its original provenance.
  z.object({ kind: z.literal('mailbox_notice'), runId: id, messageIds: z.array(z.uuid()).min(1).max(50) }),
])
export type RunCommand = z.infer<typeof runCommandSchema>

/**
 * `GET /v1/devices/:deviceId/commands?wait=<seconds>&skip=<run ids>`:
 * pending commands for runs pinned to this device, except the skipped runs. Answers at once when some are pending,
 * otherwise holds the request up to `wait` seconds (long-poll) and answers
 * with whatever arrived, possibly nothing.
 */
export const runCommandsResponse = z.object({
  commands: z.array(runCommandSchema).max(500),
  /** Owner-scoped reads, delivered only to a daemon advertising protocol v1. */
  workspaceRequests: z.array(workspaceReadCommand).max(4).optional(),
  /**
   * Runs queued for this device (outside `skip`), so it claims them now
   * instead of on its next heartbeat. A queued run also ends the long-poll.
   * Absent from older servers; the heartbeat still claims either way.
   */
  queuedRuns: z.array(id).max(100).optional(),
  /** Only for a daemon that sent `COMMANDS_DAEMON_LATEST_PARAM`; a malformed value is dropped. */
  daemonVersions: daemonVersionsSchema.optional().catch(undefined),
  /** The oldest pending device command (as the heartbeat's), so a person's update reaches the device now. */
  deviceCommands: z.array(deviceManagementCommand).max(1).optional().catch(undefined),
})
export type RunCommandsResponse = z.infer<typeof runCommandsResponse>

/** `POST /v1/devices/:deviceId/commands/ack`: inputs the agent now has. */
export const runCommandsAck = z.object({
  delivered: z.array(z.uuid()).max(500),
})
export type RunCommandsAck = z.infer<typeof runCommandsAck>

// --- Browsing a device's folders (ADR 0037) -----------------------------------
//
// Choosing a repository for a device means choosing a folder on THAT device,
// not on the screen the person is looking at. The app asks the server
// (`fsBrowse`, a user token), the server queues the request for the device,
// the daemon picks it up on its own long-poll (`fsRequests`), lists the folder
// and answers (`fsRespond`). Only folders are listed, never file contents.

export const FS_REQUESTS_MAX_WAIT_SECONDS = 25
/** How long `fsBrowse` waits for the device before answering 504. */
export const FS_BROWSE_TIMEOUT_MS = 10_000
export const FS_MAX_ENTRIES = 500

export const fsBrowseRequest = z.object({
  /** Absolute path on the device; omitted: the device's home folder. */
  path: z.string().trim().min(1).max(4_000).optional(),
  showHidden: z.boolean().optional(),
})
export type FsBrowseRequest = z.infer<typeof fsBrowseRequest>

/** What the daemon is asked: a browse request with the server's request id. */
export const fsPendingRequest = fsBrowseRequest.extend({ id: z.uuid() })
export type FsPendingRequest = z.infer<typeof fsPendingRequest>

export const fsRequestsResponse = z.object({
  requests: z.array(fsPendingRequest).max(50),
})
export type FsRequestsResponse = z.infer<typeof fsRequestsResponse>

export const fsEntry = z.object({
  name: z.string().max(1_000),
  path: z.string().max(4_000),
  /** The folder is the top level of a git repo (it has a `.git`). */
  isRepo: z.boolean(),
})
export type FsEntry = z.infer<typeof fsEntry>

export const fsListing = z.object({
  ok: z.literal(true),
  path: z.string().max(4_000),
  /** Null at the filesystem root. */
  parent: z.string().max(4_000).nullable(),
  home: z.string().max(4_000),
  /** `darwin`, `linux`, `win32`: for path separators and wording. */
  platform: z.string().max(50),
  entries: z.array(fsEntry).max(FS_MAX_ENTRIES),
  /** More folders existed than `FS_MAX_ENTRIES`. */
  truncated: z.boolean(),
  /**
   * The git repo `path` is in, if any: its top level and `origin` (or the
   * first remote). This is what `device.addRepo` should be given.
   */
  repo: z
    .object({
      path: z.string().max(4_000),
      remoteUrl: z.string().max(2_000).nullable(),
    })
    .nullable(),
})
export type FsListing = z.infer<typeof fsListing>

export const FS_ERROR_CODES = [
  "not_found",
  "not_a_directory",
  "denied",
  "failed",
] as const
export const fsFailure = z.object({
  ok: z.literal(false),
  code: z.enum(FS_ERROR_CODES),
  message: z.string().max(1_000),
})
export type FsFailure = z.infer<typeof fsFailure>

/** The daemon's answer, and `fsBrowse`'s 200 body. */
export const fsResult = z.discriminatedUnion("ok", [fsListing, fsFailure])
export type FsResult = z.infer<typeof fsResult>

export const FS_ROUTES = {
  /** App → server, user token, device owner only. */
  browse: "/v1/devices/:deviceId/fs/browse",
  /** Daemon → server, long-poll. */
  requests: "/v1/devices/:deviceId/fs/requests",
  /** Daemon → server. */
  respond: "/v1/devices/:deviceId/fs/requests/:requestId",
} as const

export const fsPaths = {
  browse: (deviceId: string) => `/v1/devices/${seg(deviceId)}/fs/browse`,
  requests: (deviceId: string, waitSeconds: number) =>
    `/v1/devices/${seg(deviceId)}/fs/requests?wait=${waitSeconds}`,
  respond: (deviceId: string, requestId: string) =>
    `/v1/devices/${seg(deviceId)}/fs/requests/${seg(requestId)}`,
}
