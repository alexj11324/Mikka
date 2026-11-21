import type { NativeCoordinatorJob, NativeCoordinatorCommand, NativeCoordinatorToolResult } from "@mikka/protocol/coordinator"
// The daemon's only view of the server. Everything the daemon needs from the
// cloud goes through `ServerLink`, so tests use `MemoryServer` and the real
// transport (`HttpServerLink`, apps/server routes) plugs in behind the same
// interface. Every payload shape is owned by packages/protocol (`./device`,
// `./run`); nothing is declared here (ADR 0016).
//
// Run output is appended per run with the daemon's producer sequence
// (`fromSeq`), so a batch re-sent after a lost response is applied once.
//
// The daemon never writes issue state. It reports how each run ended
// (`completeRun`: stop reason + handoff report) and the server decides the
// issue's next step (the orchestrator, later; `MemoryServer.nextOwner` now).
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import type { SkillReceiptRevalidation } from '@mikka/protocol/skill'

import {
  isTerminalRunState,
  SESSION_LEASE_MS,
  type DeviceGatewayTicket,
  type DeviceRegistration,
  type DeviceReport,
  type DeviceReportResult,
  type DeviceRepo,
  type FsPendingRequest,
  type FsResult,
  type RunAssignment,
  type RunCompletion,
  type RunCommand,
  type RunPatch,
  type RunState,
  type StopReason,
  type RunCheckpoint,
  type RunCheckpointReceipt,
  type DaemonVersions,
  type DeviceManagementCommand,
  type DeviceRegistered,
} from "@mikka/protocol"

import type { CaptureUploadRequest, CaptureUploadResponse, CaptureView, ScreenCaptureRequest, ScreenCaptureResponse } from "@mikka/protocol/capture"
import type { RunChunk } from "./chunks"
import type { ToolApprovalGate } from "./agents/tool-approval"
import type { RunMailbox } from './run-mailbox'
import type { RunDrive } from './run-drive'
import type { WorkspaceReadCommand, WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import type { ChatFileDownload } from '@mikka/protocol/chat-attachments'
import type { NativeBrokerContext, NativeBrokerRequest, NativeLease } from '@mikka/protocol/subscription'
import { DeviceGatewayRequiredError, DeviceSessionRequiredError, RunNotPinnedHereError, ServerUnreachableError } from "./errors"
import type { DeviceGatewaySocket } from "./device-gateway"

export type {
  DeviceRepo,
  RunAssignment,
  RunCommand,
  RunPatch,
  SetupRecipe,
} from "@mikka/protocol"
export { DEVICE_SESSION_LOCAL_GRACE_MS } from "@mikka/protocol"

/** What the daemon sends when it registers (`deviceId` re-registers). */
export type DeviceInfo = Omit<DeviceRegistration, "deviceId">

export interface ChunkBatch {
  /** Producer sequence of the first chunk (1-based, per run). */
  fromSeq: number
  chunks: RunChunk[]
}

/**
 * Calls throw `ServerUnreachableError` when the server cannot be reached;
 * the daemon keeps running and retries (offline tolerance, R13).
 */
export interface ServerLink {
  downloadChatFile?(assignment: RunAssignment, id: string, signal: AbortSignal): Promise<ChatFileDownload>
  /** Authenticated policy validation before repository/setup effects, including resume. */
  verifyRunPolicy?(assignment: RunAssignment, signal: AbortSignal): Promise<unknown>
  prepareRunToolApproval?(assignment: RunAssignment, signal: AbortSignal, check: () => void, worktree?: string): Promise<ToolApprovalGate>
  /** A gateway push or a reopened socket: every live run rechecks its current authority. */
  invalidateRunControls?(): void
  /**
   * Called when any route answers 426 `daemonUpgradeRequired`, wherever the
   * request came from, so the daemon stops before its next request.
   */
  onUpgradeRequired?(listener: (latest?: string) => void): void
  /** Optional host-only adapter for the claimed run; never model-supplied. */
  prepareRunMailbox?(assignment: RunAssignment, signal: AbortSignal, check: () => void): Promise<RunMailbox | undefined>
  /** The run's shared Drive mirror over its MCP endpoint (decision 2026-11-19-2200). */
  prepareRunDrive?(assignment: RunAssignment, signal: AbortSignal): Promise<RunDrive | undefined>
  claimCoordinator?(deviceId: string, signal: AbortSignal): Promise<NativeCoordinatorJob | null>
  coordinatorCommand?(deviceId: string, turnId: string, command: NativeCoordinatorCommand, signal: AbortSignal): Promise<void>
  coordinatorToolResult?(deviceId: string, turnId: string, callId: string, signal: AbortSignal): Promise<NativeCoordinatorToolResult>

  /**
   * `credential` is the session from `mikka daemon login` (Better Auth
   * device authorization, RFC 8628) or one the signed-in desktop handed
   * over. `knownDeviceId` re-registers a device this daemon registered
   * before.
   */
  registerDevice(
    credential: string,
    info: DeviceInfo,
    knownDeviceId?: string
  ): Promise<{ deviceId: string; tracing?: DeviceRegistered["tracing"] }>
  /**
   * What changed on the device, sent once when it changes and once after each
   * socket open (decision 2026-11-17-2215). It renews nothing.
   */
  report(deviceId: string, report: DeviceReport): Promise<DeviceReportResult>
  listRepos(deviceId: string): Promise<DeviceRepo[]>
  /** Ids of queued runs pinned to this device. */
  pendingRuns(deviceId: string): Promise<string[]>
  /** Fails with `RunNotPinnedHereError` for runs pinned elsewhere. */
  claimRun(deviceId: string, runId: string, signal?: AbortSignal, options?: { initialRepository: true }): Promise<RunAssignment>
  localComputerAuthority?(deviceId: string, runId: string): Promise<NonNullable<RunAssignment['localComputer']>>
  /** Receipted resumes require a current online source/access/lease fence. */
  validateSkillReceipt?(runId:string,receiptId:string):Promise<SkillReceiptRevalidation>
  /** Private hosted-run channel; these methods never return provider tokens. */
  nativeContext?(deviceId:string,runId:string,signal?:AbortSignal,requireModelCatalogue?:boolean):Promise<NativeBrokerContext>
  nativeRequest?(deviceId:string,runId:string,payload:NativeBrokerRequest,signal?:AbortSignal):Promise<{contentType:string;body:ReadableStream<Uint8Array>}>
  /** A device run's subscription access lease (never a refresh grant); asked again before it expires. */
  nativeLease?(deviceId:string,runId:string,signal?:AbortSignal):Promise<NativeLease>
  /** Natural-expiry renewal only; initial GitHub credentials arrive with the claim. */
  githubLease?(deviceId:string,runId:string,signal?:AbortSignal):Promise<{ token: string; expiresAt: string | null }>
  /**
   * Screenshots and recordings a run keeps as evidence (`@mikka/protocol/capture`).
   * Optional: links without them keep the files on this machine.
   */
  beginCapture?(runId: string, request: CaptureUploadRequest, signal?: AbortSignal): Promise<CaptureUploadResponse>
  resumeCapture?(runId: string, captureId: string, signal?: AbortSignal): Promise<CaptureUploadResponse>
  sendCapture?(runId: string, captureId: string, upload: CaptureUploadResponse["upload"], bytes: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>
  completeCapture?(runId: string, captureId: string, signal?: AbortSignal): Promise<CaptureView>
  /** The cloud computer's capture tools for a run on this cloud worker. */
  screenCapture?(runId: string, request: ScreenCaptureRequest, signal?: AbortSignal): Promise<ScreenCaptureResponse>
  /** Appends to the run's event stream; returns the new tail offset. */
  appendRunChunks(runId: string, batch: ChunkBatch): Promise<{ offset: string }>
  updateRun(runId: string, patch: RunPatch): Promise<void>
  /** Reports how the run ended, once, after its terminal `updateRun`. */
  completeRun(runId: string, completion: RunCompletion): Promise<void>
  /**
   * Saves the run's work in progress; the server keeps the latest one so
   * another machine can take the run over. Optional: links without it
   * keep work on this machine only.
   */
  checkpointRun?(runId: string, checkpoint: RunCheckpoint): Promise<RunCheckpointReceipt | void>
  /**
   * Messages people sent this device's runs and stops they asked for
   * (ADR 0018), runs queued for it (`onQueuedRuns`) and device commands.
   * The daemon reads once per gateway push or socket open, with
   * `waitSeconds` 0; it never long-polls (decision 2026-11-17-2215).
   */
  fetchCommands(
    deviceId: string,
    waitSeconds: number,
    options?: FetchCommandsOptions
  ): Promise<RunCommand[]>
  answerWorkspaceRead?(deviceId: string, requestId: string, receipt: WorkspaceReadReceipt, options: { expiresAt: string; signal?: AbortSignal }): Promise<void>
  /**
   * A short-lived ticket for the device session socket. A server without a
   * gateway refuses with `DeviceGatewayRequiredError`; it has no devices.
   */
  deviceGateway(
    deviceId: string,
    signal?: AbortSignal
  ): Promise<DeviceGatewayTicket>
  /** Opens the session socket for a ticket; the daemon uses the global WebSocket without it. */
  openDeviceGateway?(url: string, protocol: string): DeviceGatewaySocket
  /** Marks messages as handed to their agents. */
  ackCommands(deviceId: string, delivered: string[], refusedSteers?: string[]): Promise<void>
  /**
   * Folder requests from the app's repository picker (ADR 0037). Long-polls
   * like `fetchCommands`. Optional: links without it never browse.
   */
  fetchFsRequests?(
    deviceId: string,
    waitSeconds: number,
    options?: { signal?: AbortSignal }
  ): Promise<FsPendingRequest[]>
  answerFsRequest?(
    deviceId: string,
    requestId: string,
    result: FsResult
  ): Promise<void>
}

export interface FetchCommandsOptions {
  signal?: AbortSignal
  workspaceSkip?: readonly string[]
  onWorkspaceRequests?: (requests: WorkspaceReadCommand[]) => void
  skipRuns?: readonly string[]
  onQueuedRuns?: (runIds: string[]) => void
  /**
   * The newest release this daemon knows of. Sending it asks the server for
   * releases and the oldest pending device command on this read.
   */
  updates?: { daemonLatest: string; skipDeviceCommands?: readonly string[] }
  onUpdates?: (updates: { daemonVersions?: DaemonVersions; deviceCommands: DeviceManagementCommand[] }) => void
}

/** Default caps until they become project settings. */
export const MAX_CONTINUES = 3
export const MAX_CRASH_RETRIES = 3
export const MAX_FIX_ROUNDS = 3
/** The memory server's lease bound; like the real one, it lasts as long as the session. */
export const DEFAULT_LEASE_MS = SESSION_LEASE_MS

/** Who has the issue after a run ended, and why. Never empty. */
export interface IssueOwner {
  owner: "agent" | "human" | "external"
  reason: string
}

interface MemoryRun {
  assignment: Omit<RunAssignment, "deviceId">
  deviceId: string
  state: RunState
  patches: RunPatch[]
  leaseExpiresAt?: number
  completion?: RunCompletion
  /** The latest checkpoint the daemon saved. */
  checkpoint?: RunCheckpoint
}

type QueueRunInput = Omit<RunAssignment, "deviceId" | "runId"> & {
  runId?: string
}

type MemorySocketEvent = { data?: unknown; code?: number }

/** The memory server's device gateway socket: opens on the next turn, answers pings, carries `work`. */
class MemoryGatewaySocket implements DeviceGatewaySocket {
  readyState = 0
  private readonly listeners = new Map<string, Set<(event: MemorySocketEvent) => void>>()
  constructor(private readonly server: MemoryServer, readonly deviceId: string) {
    setTimeout(() => {
      if (this.readyState !== 0) return
      if (!server.online) { this.readyState = 3; this.emit("error", {}); return }
      this.readyState = 1
      server.sockets.add(this)
      this.emit("open", {})
    }, 0)
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("socket not open")
    if (data === "ping") queueMicrotask(() => this.message("pong"))
  }
  /** A frame from the server. */
  message(data: string) { if (this.readyState === 1) this.emit("message", { data }) }
  close(code?: number) {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.server.sockets.delete(this)
    this.emit("close", { code })
  }
  addEventListener(type: string, listener: (event: MemorySocketEvent) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: (event: MemorySocketEvent) => void) { this.listeners.get(type)?.delete(listener) }
  private emit(type: string, event: MemorySocketEvent) { for (const listener of [...this.listeners.get(type) ?? []]) listener(event) }
}

/**
 * In-memory stand-in for the server: tests, and `--server memory` in dev
 * until the real link is wired. `online = false` simulates a network cut for
 * requests; `closeSessions` drops the device gateway sockets.
 */
export class MemoryServer {
  online = true
  /** False: the ticket route refuses like a server without a device gateway. */
  gateway = true
  /** True: a claim needs an open session socket for the device, as on the real server. */
  requireSession = false
  readonly devices = new Map<
    string,
    { credential: string; info: DeviceInfo; reports: DeviceReport[] }
  >()
  /** Open device gateway sockets. */
  readonly sockets = new Set<MemoryGatewaySocket>()

  readonly repos = new Map<string, DeviceRepo[]>()
  readonly runs = new Map<string, MemoryRun>()
  /** Durable stream per run; the offset is the chunk count. */
  readonly streams = new Map<string, RunChunk[]>()
  readonly issueStatus = new Map<string, string>()
  /** Messages people sent a run, by message id (ADR 0018). */
  readonly inputs = new Map<
    string,
    { runId: string; text: string; deliveredAt?: number }
  >()
  /** Runs a person asked to stop. */
  readonly stopRequests = new Set<string>()
  private wakeCommands: (() => void)[] = []
  /** Next owner of each issue after its latest run ended. */
  readonly issueOwner = new Map<string, IssueOwner>()
  /** Per issue, how often each stop reason handed it back to an agent. */
  private readonly retries = new Map<string, Map<StopReason, number>>()
  private readonly leaseMs: number

  /** `fixedDeviceId` is handed out on registration (tests, dev). */
  constructor(
    private readonly fixedDeviceId?: string,
    options: { leaseMs?: number } = {}
  ) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  }

  /**
   * Stand-in for the orchestrator's decision: who picks the issue up after a
   * run stopped. Only a submission whose verify passed goes to review.
   */
  nextOwner(
    issueId: string,
    { stopReason, report }: RunCompletion
  ): IssueOwner {
    const counts = this.retries.get(issueId) ?? new Map<StopReason, number>()
    this.retries.set(issueId, counts)
    const retry = (reason: string, cap: number): IssueOwner => {
      const n = (counts.get(stopReason) ?? 0) + 1
      counts.set(stopReason, n)
      return n > cap
        ? { owner: "human", reason: "needs_human" }
        : { owner: "agent", reason }
    }
    switch (stopReason) {
      case "submitted":
        // Only the daemon's own verify result counts. Unverified work never
        // goes to review: a human decides how to check it.
        if (report.verify.status === "passed")
          return { owner: "human", reason: "review" }
        return report.verify.status === "failed"
          ? retry("fix_verify", MAX_FIX_ROUNDS)
          : { owner: "human", reason: "unverified" }
      case "turn_ended":
        return retry("continue", MAX_CONTINUES)
      case "asked_human":
        return { owner: "human", reason: "answer_question" }
      case "blocked":
        return { owner: "external", reason: report.blockedOn ?? "blocked" }
      case "error":
      case "timeout":
        return retry("retry", MAX_CRASH_RETRIES)
      case "device_lost":
        return { owner: "external", reason: "device_offline" }
      case "quota_exhausted":
        return { owner: "external", reason: "quota_exhausted" }
      case "provider_failure":
        return { owner: "external", reason: "provider_failure" }
      case "cancelled":
        return { owner: "human", reason: "cancelled" }
    }
  }

  /**
   * Runs nobody is responsible for: active without a fresh lease, or ended
   * without a completion and a next owner. Must be 0 (no-stall invariant).
   */
  unownedRuns(now = Date.now()): string[] {
    return [...this.runs]
      .filter(([, run]) => {
        if (run.state === "queued") return false
        if (!isTerminalRunState(run.state))
          return (run.leaseExpiresAt ?? 0) < now
        return !run.completion || !this.issueOwner.has(run.assignment.issueId)
      })
      .map(([runId]) => runId)
  }

  addRepo(deviceId: string, repo: DeviceRepo) {
    this.repos.set(deviceId, [...(this.repos.get(deviceId) ?? []), repo])
  }

  queueRun(deviceId: string, run: QueueRunInput): string {
    const runId = run.runId ?? randomUUID()
    // Memory fixtures may identify an isolated source repo by path. The real
    // HTTP server always supplies remoteUrl and never sends checkout paths.
    const fixturePath = this.repos.get(deviceId)?.find(repo => repo.repoId === run.repoId)?.path
    this.runs.set(runId, {
      assignment: { ...run, runId, remoteUrl: run.remoteUrl ?? (fixturePath ? pathToFileURL(fixturePath).href : undefined) },
      deviceId,
      state: "queued",
      patches: [],
    })
    this.issueStatus.set(run.issueId, "in_progress")
    this.pushWork(deviceId)
    return runId
  }

  /** A person's message to a running agent; returns its message id. */
  sendInput(runId: string, text: string): string {
    const messageId = randomUUID()
    this.inputs.set(messageId, { runId, text })
    this.notifyCommands()
    return messageId
  }

  requestStop(runId: string) {
    this.stopRequests.add(runId)
    this.notifyCommands()
  }

  private notifyCommands() {
    const wake = this.wakeCommands
    this.wakeCommands = []
    for (const fn of wake) fn()
    const devices = new Set([...this.stopRequests, ...[...this.inputs.values()].map(input => input.runId)]
      .flatMap(runId => this.runs.get(runId)?.deviceId ?? []))
    for (const deviceId of devices) this.pushWork(deviceId)
  }

  /** The gateway's `work` signal to a device's open sockets. */
  pushWork(deviceId: string) {
    for (const socket of [...this.sockets]) if (socket.deviceId === deviceId) socket.message("work")
  }

  /** Whether a device holds an open session socket. */
  sessionOpen(deviceId: string) {
    return [...this.sockets].some(socket => socket.deviceId === deviceId)
  }

  /** Drops every open session socket, with a close code (4001: update required). */
  closeSessions(code?: number) {
    for (const socket of [...this.sockets]) socket.close(code)
  }

  private pendingCommands(
    deviceId: string,
    skip: ReadonlySet<string>
  ): RunCommand[] {
    const active = (runId: string) => {
      const run = this.runs.get(runId)
      return (
        !skip.has(runId) &&
        run?.deviceId === deviceId &&
        run.state !== "queued" &&
        !isTerminalRunState(run.state)
      )
    }
    const commands: RunCommand[] = [...this.stopRequests]
      .filter(active)
      .map((runId) => ({ kind: "stop", runId }))
    for (const [messageId, input] of this.inputs) {
      if (input.deliveredAt || !active(input.runId)) continue
      if (this.stopRequests.has(input.runId)) continue
      commands.push({
        kind: "input",
        runId: input.runId,
        messageId,
        text: input.text,
      })
    }
    return commands
  }

  chunksFor(runId: string): RunChunk[] {
    return this.streams.get(runId) ?? []
  }

  private check() {
    if (!this.online) throw new ServerUnreachableError()
  }

  link(): ServerLink {
    return {
      registerDevice: async (credential, info, knownDeviceId) => {
        this.check()
        const existing = [...this.devices].find(
          ([id, d]) =>
            d.credential === credential &&
            (!knownDeviceId || id === knownDeviceId)
        )
        const deviceId = existing?.[0] ?? this.fixedDeviceId ?? randomUUID()
        this.devices.set(deviceId, { credential, info, reports: this.devices.get(deviceId)?.reports ?? [] })
        return { deviceId }
      },
      report: async (deviceId, report) => {
        this.check()
        this.devices.get(deviceId)?.reports.push(report)
        return {}
      },
      deviceGateway: async (deviceId) => {
        this.check()
        if (!this.gateway) throw new DeviceGatewayRequiredError()
        return { url: `memory://gateway/${encodeURIComponent(deviceId)}`, protocol: `mikka-ticket-1-${"0".repeat(64)}` }
      },
      openDeviceGateway: (url) => new MemoryGatewaySocket(this, decodeURIComponent(url.slice("memory://gateway/".length))),
      listRepos: async (deviceId) => {
        this.check()
        return this.repos.get(deviceId) ?? []
      },
      pendingRuns: async (deviceId) => {
        this.check()
        return [...this.runs]
          .filter(([, r]) => r.deviceId === deviceId && r.state === "queued")
          .map(([id]) => id)
      },
      claimRun: async (deviceId, runId) => {
        this.check()
        if (this.requireSession && !this.sessionOpen(deviceId)) throw new DeviceSessionRequiredError()
        const run = this.runs.get(runId)
        if (!run || run.deviceId !== deviceId)
          throw new RunNotPinnedHereError(runId)
        if (run.state === "queued") run.state = "preparing"
        run.leaseExpiresAt = Date.now() + this.leaseMs
        return {
          ...run.assignment,
          deviceId,
          leaseExpiresAt: new Date(run.leaseExpiresAt).toISOString(),
        }
      },
      appendRunChunks: async (runId, batch) => {
        this.check()
        const stream = this.streams.get(runId) ?? []
        // Idempotent producer: skip chunks already applied.
        // A fresh in-memory server (dev daemon restarted) has no prefix; accept the tail.
        const skip = Math.max(0, stream.length - (batch.fromSeq - 1))
        stream.push(...batch.chunks.slice(skip))
        this.streams.set(runId, stream)
        return { offset: String(stream.length) }
      },
      updateRun: async (runId, patch) => {
        this.check()
        const run = this.runs.get(runId)
        if (!run) return
        if (patch.observedModel === undefined) run.state = patch.state
        run.patches.push(patch)
      },
      checkpointRun: async (runId, checkpoint) => {
        this.check()
        const run = this.runs.get(runId)
        if (!run || isTerminalRunState(run.state)) return
        const takenAt = new Date().toISOString()
        run.checkpoint = { ...checkpoint, takenAt }
        return { runId, takenAt }
      },
      completeRun: async (runId, completion) => {
        this.check()
        const run = this.runs.get(runId)
        if (!run || run.completion) return // idempotent
        run.completion = completion
        const { issueId } = run.assignment
        const owner = this.nextOwner(issueId, completion)
        this.issueOwner.set(issueId, owner)
        // This stand-in only records the review wait. People and agents can
        // both set Done (ADR 0063); that write does not happen here.
        if (owner.reason === "review")
          this.issueStatus.set(issueId, "in_review")
      },
      fetchCommands: async (deviceId, waitSeconds, options = {}) => {
        const { signal } = options
        const skip = new Set(options.skipRuns)
        this.check()
        let pending = this.pendingCommands(deviceId, skip)
        if (pending.length === 0 && waitSeconds > 0 && !signal?.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitSeconds * 1000)
            signal?.addEventListener("abort", () => resolve(), { once: true })
            this.wakeCommands.push(() => {
              clearTimeout(timer)
              resolve()
            })
          })
          this.check()
          pending = this.pendingCommands(deviceId, skip)
        }
        return pending
      },
      ackCommands: async (_deviceId, delivered) => {
        this.check()
        for (const id of delivered) {
          const input = this.inputs.get(id)
          if (input && !input.deliveredAt) input.deliveredAt = Date.now()
        }
      },
    }
  }
}
