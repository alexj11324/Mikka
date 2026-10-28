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

import { modelNameSchema, runPolicySchema } from "./agent-policy"
import { harnessInfoSchema, harnessSchema } from "./harness"
import { quotaSnapshotSchema } from "./quota"
import { runStopReason } from "./run"
import { MAX_SKILLS_PER_RUN, runSkillSchema } from "./skill"

const id = z.string().min(1).max(64)
const isoTime = z.iso.datetime({ offset: true })

/**
 * A device counts as online while its last heartbeat is younger than this.
 * The daemon beats every 15 s, so this tolerates three missed beats.
 */
export const DEVICE_ONLINE_WINDOW_MS = 60_000

/** Lease a claim or heartbeat grants a run (ADR 0012). */
export const RUN_LEASE_MS = 90_000

export function isDeviceOnline(
  lastSeenAt: string | number | Date | null | undefined,
  now = Date.now()
): boolean {
  if (lastSeenAt === null || lastSeenAt === undefined) return false
  const seen =
    lastSeenAt instanceof Date
      ? lastSeenAt.getTime()
      : typeof lastSeenAt === "number"
        ? lastSeenAt
        : Date.parse(lastSeenAt)
  return Number.isFinite(seen) && now - seen <= DEVICE_ONLINE_WINDOW_MS
}

/** "设备 n/m 在线": how many of the user's devices are online. */
export function devicesOnline(
  devices: readonly { lastSeenAt: string | number | Date | null }[],
  now = Date.now()
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
    skipRuns: readonly string[] = []
  ) =>
    `/v1/devices/${seg(deviceId)}/commands?wait=${waitSeconds}` +
    (skipRuns.length
      ? `&${COMMANDS_SKIP_PARAM}=${skipRuns.map(seg).join(",")}`
      : ""),
  commandsAck: (deviceId: string) =>
    `/v1/devices/${seg(deviceId)}/commands/ack`,
  runEvents: (runId: string) => `/v1/runs/${seg(runId)}/events`,
  runPatch: (runId: string) => `/v1/runs/${seg(runId)}`,
  runCheckpoint: (runId: string) => `/v1/runs/${seg(runId)}/checkpoint`,
}

// --- Registration ---------------------------------------------------------

/** `POST /v1/devices/register` */
export const deviceRegistration = z.object({
  name: z.string().trim().min(1).max(200),
  hostname: z.string().max(255).nullable().optional(),
  platform: z.string().max(50),
  arch: z.string().max(50),
  daemonVersion: z.string().max(50),
  protocolVersion: z.number().int(),
  harnesses: z.array(harnessInfoSchema).max(20),
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
})
export type DeviceRegistered = z.infer<typeof deviceRegistered>

// --- Heartbeat ------------------------------------------------------------

/** Per-run part of the device heartbeat; the server renews the run's lease. */
export const heartbeatRunSchema = z.object({
  runId: id,
  /** Last tool call, turn boundary or file change (not raw output). */
  lastProgressAt: isoTime,
})
export type HeartbeatRun = z.infer<typeof heartbeatRunSchema>

/** `POST /v1/devices/:deviceId/heartbeat` */
export const deviceHeartbeatSchema = z.object({
  harnesses: z.array(harnessInfoSchema).max(20),
  runs: z.array(heartbeatRunSchema).max(500),
  worktreeDiskBytes: z.number().int().nonnegative(),
  /**
   * Subscription windows read on this device. Absent when the daemon is not
   * polling. Numbers only, never a vendor credential (ADR 0027).
   */
  quotas: z.array(quotaSnapshotSchema).max(6).optional(),
})
export type DeviceHeartbeat = z.input<typeof deviceHeartbeatSchema>

export const heartbeatResultSchema = z.object({
  /** Renewed lease expiry per run id; a run missing here is not renewed. */
  leases: z.record(z.string(), isoTime),
  /**
   * Runs the device reported that it no longer holds: they ended on the
   * server, or went to another attempt after the lease ran out. The daemon
   * stops them now instead of when their lease runs out.
   */
  revoked: z.array(id).max(500).optional(),
  /** Short-lived cloud device token, returned only over its authenticated link. */
  cloudCredential: z.string().regex(/^orv_[A-Za-z0-9_-]{43}$/).optional(),
})
export type HeartbeatResult = z.input<typeof heartbeatResultSchema>

// --- Checkpoints ------------------------------------------------------------

/** Largest gzipped checkpoint patch the server keeps. */
export const RUN_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024

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
})
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>

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

/** A repository record and its identity-scoped settings. */
export const deviceRepoSchema = z.object({
  repoId: id,
  name: z.string().max(500),
  /** Logical repository key; only trusted cloud runtimes use an absolute path. */
  path: z.string().min(1).max(4_000),
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
  issueId: id,
  deviceId: id,
  repoId: id,
  /** Clone URL for local runs; hosted computer assignments keep their isolated workspace. */
  remoteUrl: z.string().min(1).max(4_000).optional(),
  /** Absent means origin/HEAD after fetch. */
  baseBranch: z.string().min(1).max(500).optional(),
  harness: harnessSchema,
  prompt: z.string().max(100_000),
  /**
   * The model the harness's CLI is asked to run, from the per-harness
   * preference of the person this run works for (ADR 0060). Absent: the
   * CLI's own default. A daemon that does not know the field ignores it
   * (zod strips unknown keys), so this needs no version gate.
   */
  model: modelNameSchema.optional(),
  /** Owner-bound selection only; no subscription credential enters the assignment. */
  subscriptionBinding: z.object({
    bindingId: z.uuid(), ownerId: z.string().min(1).max(128), workspaceId: z.uuid(),
    consumerId: z.uuid(), route: z.enum(['codex_cli', 'claude_code_cli']),
  }).strict().optional(),
  /** Trusted server assignment; the model cannot choose a Bot or display. */
  computer: z.object({
    botId: z.uuid(), ownerId: z.string().min(1).max(128),
    display: z.string().regex(/^:[1-9][0-9]{0,2}$/),
    policyVersion: z.number().int().nonnegative().max(2147483647),
  }).strict().optional(),
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
  /** Run lease; renewed through the device heartbeat. */
  leaseExpiresAt: isoTime.optional(),
  /**
   * The Mikka MCP server for the agent inside this run: `report`, `ask` and
   * `blocked` reach the person's Coordinator. Send `token` as a bearer token;
   * it stops working when the run ends. Absent: the server could not issue
   * one, and the run goes ahead without it.
   */
  mcp: z.object({ url: z.url(), token: z.string().min(1).max(200), mailbox: z.literal(true).optional() }).optional(),
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
  /**
   * The latest checkpoint of the attempt this run takes over after its
   * machine went offline. Used only for a new worktree (another machine, or
   * the earlier worktree is gone): it starts at `baseCommit` (the base
   * branch when that commit is not here) with the patch applied.
   */
  resumeFrom: runCheckpointSchema.optional(),
  /**
   * The harness session to continue. A daemon that cannot resume starts a
   * new session with `prompt`, which always carries the full brief.
   */
  resumeSessionId: z.string().max(500).optional(),
  /**
   * What this run adds on top of the brief (a person's message, an answer,
   * a fix request). A resumed session gets only this as its next message;
   * a new session gets `prompt`, which already includes it.
   */
  followUp: z.string().max(100_000).optional(),
  /**
   * The workspace's agent permissions and network allow-list (ADR 0028).
   * Absent from an older server: the daemon applies the ADR 0009 defaults.
   */
  policy: runPolicySchema.optional(),
  /**
   * The skills mounted on this run's agent and still enabled, resolved at
   * claim time the way `policy` is. The daemon inlines them into the agent's
   * brief and writes them under the run's directory. Absent from an older
   * server: the run simply has none.
   */
  skills: z.array(runSkillSchema).max(MAX_SKILLS_PER_RUN).optional(),
})
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
 * Something a person asked of a run on this device. `input` is a message a
 * person sent in the run's chat (a `message` row, delivered at least once
 * until acked); `stop` repeats until the run has ended.
 */
export const runCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("input"),
    runId: id,
    messageId: z.uuid(),
    text: z.string().min(1).max(100_000),
  }),
  z.object({ kind: z.literal("stop"), runId: id }),
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
