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

import {
  isTerminalRunState,
  RUN_LEASE_MS,
  type DeviceHeartbeat,
  type DeviceRegistration,
  type DeviceRepo,
  type FsPendingRequest,
  type FsResult,
  type HeartbeatResult,
  type RunAssignment,
  type RunCompletion,
  type RunCommand,
  type RunPatch,
  type RunState,
  type StopReason,
  type RunCheckpoint,
} from "@mikka/protocol"

import type { LocalComputerDecision, LocalComputerRequest } from "@mikka/protocol/computer"
import type { CaptureUploadRequest, CaptureUploadResponse, CaptureView, ScreenCaptureRequest, ScreenCaptureResponse } from "@mikka/protocol/capture"
import type { RunChunk } from "./chunks"
import type { RunMailbox } from './run-mailbox'
import type { NativeBrokerContext, NativeBrokerRequest } from '@mikka/protocol/subscription'
import { RunNotPinnedHereError, ServerUnreachableError } from "./errors"

export type {
  DeviceRepo,
  RunAssignment,
  RunCommand,
  RunPatch,
  SetupRecipe,
} from "@mikka/protocol"

/** What the daemon sends when it registers (`deviceId` re-registers). */
export type DeviceInfo = Omit<DeviceRegistration, "deviceId">

export type HeartbeatStatus = DeviceHeartbeat

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
  /** Optional host-only adapter for the claimed run; never model-supplied. */
  prepareRunMailbox?(assignment: RunAssignment, signal: AbortSignal, check: () => void): Promise<RunMailbox | undefined>
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
  ): Promise<{ deviceId: string }>
  /** Also renews the leases of the runs listed in `status.runs`. */
  heartbeat(deviceId: string, status: HeartbeatStatus): Promise<HeartbeatResult>
  listRepos(deviceId: string): Promise<DeviceRepo[]>
  /** Ids of queued runs pinned to this device. */
  pendingRuns(deviceId: string): Promise<string[]>
  /** Fails with `RunNotPinnedHereError` for runs pinned elsewhere. */
  claimRun(deviceId: string, runId: string): Promise<RunAssignment>
  /** Owner-reviewed computer requests; responses carry decisions only. */
  syncComputerReviews?(deviceId: string, requests: LocalComputerRequest[], signal?: AbortSignal): Promise<LocalComputerDecision[]>
  /** Private hosted-run channel; these methods never return provider tokens. */
  nativeContext?(deviceId:string,runId:string,signal?:AbortSignal):Promise<NativeBrokerContext>
  nativeRequest?(deviceId:string,runId:string,payload:NativeBrokerRequest,signal?:AbortSignal):Promise<{contentType:string;body:ReadableStream<Uint8Array>}>
  /**
   * Screenshots and recordings a run keeps as evidence (`@mikka/protocol/capture`).
   * Optional: links without them keep the files on this machine.
   */
  beginCapture?(runId: string, request: CaptureUploadRequest): Promise<CaptureUploadResponse>
  resumeCapture?(runId: string, captureId: string): Promise<CaptureUploadResponse>
  sendCapture?(runId: string, captureId: string, upload: CaptureUploadResponse["upload"], bytes: Uint8Array, contentType: string): Promise<void>
  completeCapture?(runId: string, captureId: string): Promise<CaptureView>
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
  checkpointRun?(runId: string, checkpoint: RunCheckpoint): Promise<void>
  /**
   * Messages people sent this device's runs and stops they asked for
   * (ADR 0018). Long-polls up to `waitSeconds` when nothing is pending;
   * `signal` ends the wait early (daemon stopping).
   */
  fetchCommands(
    deviceId: string,
    waitSeconds: number,
    options?: { signal?: AbortSignal; skipRuns?: readonly string[] }
  ): Promise<RunCommand[]>
  /** Marks messages as handed to their agents. */
  ackCommands(deviceId: string, delivered: string[]): Promise<void>
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

/** Default caps until they become project settings. */
export const MAX_CONTINUES = 3
export const MAX_CRASH_RETRIES = 3
export const MAX_FIX_ROUNDS = 3
export const DEFAULT_LEASE_MS = RUN_LEASE_MS

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

/**
 * In-memory stand-in for the server: tests, and `--server memory` in dev
 * until the real link is wired. `online = false` simulates a network cut.
 */
export class MemoryServer {
  online = true
  readonly devices = new Map<
    string,
    { credential: string; info: DeviceInfo; lastHeartbeat?: HeartbeatStatus }
  >()

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
    this.runs.set(runId, {
      assignment: { ...run, runId },
      deviceId,
      state: "queued",
      patches: [],
    })
    this.issueStatus.set(run.issueId, "in_progress")
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
        this.devices.set(deviceId, { credential, info })
        return { deviceId }
      },
      heartbeat: async (deviceId, status) => {
        this.check()
        const device = this.devices.get(deviceId)
        if (device) device.lastHeartbeat = status

        const leases: Record<string, string> = {}
        const revoked: string[] = []
        for (const { runId } of status.runs) {
          const run = this.runs.get(runId)
          if (!run) continue
          // The real server also takes back runs it no longer knows; this one
          // forgets every run on restart (`--server memory`), so it does not.
          if (run.deviceId !== deviceId || isTerminalRunState(run.state)) {
            revoked.push(runId)
            continue
          }
          run.leaseExpiresAt = Date.now() + this.leaseMs
          leases[runId] = new Date(run.leaseExpiresAt).toISOString()
        }
        return { leases, ...(revoked.length ? { revoked } : {}) }
      },
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
        run.state = patch.state
        run.patches.push(patch)
      },
      checkpointRun: async (runId, checkpoint) => {
        this.check()
        const run = this.runs.get(runId)
        if (run && !isTerminalRunState(run.state)) run.checkpoint = checkpoint
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
