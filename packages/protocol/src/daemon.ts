// Contracts between the daemon and its local peers: the JSON-RPC control
// channel (desktop main / `mikka daemon status` <-> daemon), harness ids
// and run states. The daemon and the desktop supervisor both decode with
// these schemas; nobody re-declares the shapes locally
// (docs/architecture.md, "Package rules").
//
// Run output is not declared here: the daemon emits Vercel AI SDK
// `UIMessageChunk`s (`ai` package, types only) with Mikka data parts
// (`packages/daemon/src/chunks.ts`), appended to one durable stream per run.
//
// The daemon <-> server REST contract lives in ./device, run completion and
// the handoff report in ./run.
//
// Naming (firm): the machine running the daemon is a `device`; an agent is
// identified only by its `harness`. "runtime" means a JS runtime, nothing else.
import { z } from "zod"

import { harnessInfoSchema, harnessSchema } from "./harness"
import { quotaSnapshotReportSchema, quotaSnapshotSchema } from "./quota"
import {
  RUN_STOP_REASONS,
  runReport,
  runStopReason,
  type RunReport,
  type RunStopReason,
} from "./run"

/** Bumped on any breaking change to the local RPC methods below. */
export const DAEMON_PROTOCOL_VERSION = 2

export {
  HARNESSES,
  harnessInfoSchema,
  harnessSchema,
  type Harness,
  type HarnessInfo,
} from "./harness"

export const RUN_STATES = [
  "queued",
  "preparing",
  "running",
  "waiting_input",
  "finishing",
  "succeeded",
  /** Ended without success or failure: the turn ended, a question, a blocker. */
  "stopped",
  "failed",
  "cancelled",
] as const
export const runStateSchema = z.enum(RUN_STATES)
export type RunState = z.infer<typeof runStateSchema>

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
]

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state)
}

/**
 * Why a run stopped (owned by ./run). Every terminal transition carries one.
 * A turn ending is not success: only `submitted` (the agent explicitly
 * handed in its work, and the daemon's verify passed) reaches review.
 */
export const STOP_REASONS = RUN_STOP_REASONS
export const stopReasonSchema = runStopReason
export type StopReason = RunStopReason

/** Daemon-local terminal run state for a stop reason. */
export function runStateForStop(reason: StopReason): RunState {
  if (reason === "submitted") return "succeeded"
  if (reason === "cancelled") return "cancelled"
  if (
    reason === "turn_ended" ||
    reason === "asked_human" ||
    reason === "blocked"
  )
    return "stopped"
  return "failed"
}

/** The handoff report is `RunReport` (./run); kept under the daemon's name. */
export const handoffReportSchema = runReport
export type HandoffReport = RunReport

// --- Local JSON-RPC 2.0 ---------------------------------------------------

/** Application error codes (JSON-RPC reserves -32768..-32000 for itself). */
export const DAEMON_RPC_ERRORS = {
  handshakeRequired: 4001,
  protocolMismatch: 4002,
  unauthorized: 4003,
  repoNotAllowed: 4010,
  runNotFound: 4011,
  runNotPinnedHere: 4012,
  harnessNotSupported: 4013,
  invalidId: 4014,
  serverUnreachable: 4020,
  draining: 4030,
} as const

export const helloParams = z.object({
  protocolVersion: z.number().int(),
  /** Contents of the daemon's `daemon.secret` file in the flavor data dir. */
  secret: z.string(),
  client: z.object({ name: z.string(), version: z.string() }),
})
export type HelloParams = z.infer<typeof helloParams>

export const helloResult = z.object({
  protocolVersion: z.number().int(),
  daemonVersion: z.string(),
  pid: z.number().int(),
})
export type HelloResult = z.infer<typeof helloResult>

export const runSummarySchema = z.object({
  runId: z.string(),
  issueId: z.string(),
  harness: harnessSchema,
  state: runStateSchema,
  worktree: z.string().nullable(),
  sessionId: z.string().nullable(),
  /** Chunks emitted so far (the daemon-local producer sequence). */
  chunks: z.number().int().nonnegative(),
  error: z.string().nullable(),
  /** Set once the run reached a terminal state. */
  stopReason: stopReasonSchema.optional(),
  /** Lease from the server; the daemon stops the run if it cannot renew it. */
  leaseExpiresAt: z.string().optional(),
  /** Last progress seen by the watchdog (ISO time), while the run is active. */
  lastProgressAt: z.string().optional(),
})
export type RunSummary = z.infer<typeof runSummarySchema>

export const daemonStatusSchema = z.object({
  daemonVersion: z.string(),
  protocolVersion: z.number().int(),
  pid: z.number().int(),
  dataDir: z.string(),
  /** Null until the device is registered with the server. */
  deviceId: z.string().nullable(),
  /** The workspace the device credential was handed over for, if named. */
  workspaceId: z.string().nullable(),
  /** Holds a device credential (it may still be refused by the server). */
  signedIn: z.boolean(),
  server: z.enum(["online", "offline", "unregistered"]),
  harnesses: z.array(harnessInfoSchema),
  runs: z.array(runSummarySchema),
  /** Bytes used by run worktrees under the daemon's data dir. */
  worktreeDiskBytes: z.number().int().nonnegative(),
  /** Items buffered on disk, waiting for the server. */
  pendingUploads: z.number().int().nonnegative(),
  draining: z.boolean(),
  /** Latest subscription snapshots. Empty when quota polling is off. */
  quotas: z.array(quotaSnapshotSchema).max(6),
})
export type DaemonStatus = z.infer<typeof daemonStatusSchema>

const empty = z.object({}).optional()
const ok = z.object({ ok: z.literal(true) })

/** Every method except `daemon.hello` requires a completed handshake. */
export const daemonRpc = {
  "daemon.hello": { params: helloParams, result: helloResult },
  "daemon.status": { params: empty, result: daemonStatusSchema },
  /** Cached subscription snapshots. Does not start a vendor request. */
  "quota.snapshot": { params: empty, result: quotaSnapshotReportSchema },
  /** Stop accepting runs, journal active ones for resume, then exit. */
  "daemon.drain": { params: empty, result: ok },
  /** Hand the daemon a device credential obtained by the signed-in desktop. */
  "device.setCredential": {
    params: z.object({
      credential: z.string().min(1),
      /** Needed only for users in more than one workspace. */
      workspaceId: z.uuid().optional(),
    }),
    result: ok,
  },
  /** Forget the device credential (the person signed out of the app). */
  "device.clearCredential": { params: empty, result: ok },
  /** Claim a queued run pinned to this device and start it. */
  "runs.start": {
    params: z.object({ runId: z.string() }),
    result: runSummarySchema,
  },
  "runs.list": { params: empty, result: z.array(runSummarySchema) },
  /** Interject a user message into a running session. */
  "runs.send": {
    params: z.object({ runId: z.string(), text: z.string().min(1) }),
    result: ok,
  },
  "runs.cancel": {
    params: z.object({ runId: z.string() }),
    result: runSummarySchema,
  },
  /**
   * Dev only (`mikka daemon --dev --server memory`): queue and start a mock
   * run on an allow-listed repo without a server. Refused otherwise.
   */
  "dev.mockRun": {
    params: z.object({
      repoId: z.string(),
      fixture: z.string().optional(),
      baseBranch: z.string().optional(),
      /** Run after the mock submits; defaults to `git diff --check`. */
      verifyCommand: z.string().optional(),
    }),
    result: runSummarySchema,
  },
} as const

export type DaemonRpcMethod = keyof typeof daemonRpc
export type DaemonRpcParams<M extends DaemonRpcMethod> = z.input<
  (typeof daemonRpc)[M]["params"]
>
export type DaemonRpcResult<M extends DaemonRpcMethod> = z.infer<
  (typeof daemonRpc)[M]["result"]
>
