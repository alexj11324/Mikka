import { taskMcpSecretValues } from '@mikka/protocol'
import type { RepositoryGitTiming, RepositoryTimingObserver } from '../repository-git-timing'
import { toolDuration } from '../tool-duration'
import { captureRunFailure, failureFrom, type RunFailure } from "@mikka/protocol/run-failure"
import { DAEMON_VERSION } from "../paths"
// Run supervisor: owns the run state machine
//   queued -> preparing -> running <-> waiting_input -> finishing -> succeeded
//   running -> stopped | failed | cancelled (and finishing -> failed on verify)
// writes every transition to the journal (for resume) and to the outbox
// (for the server), and drives adapter sessions. Every terminal transition
// goes through `finish` with an explicit stop reason and sends one
// completion (stop reason + handoff report) to the server, which decides the
// issue's next step; the daemon never writes issue state. A session that
// just ends is `turn_ended`, not success.
//
// Liveness: a claimed run is held while the device session socket is open
// (decision 2026-11-17-2215). When the socket drops, every held run gets a
// local deadline of the drop plus DEVICE_SESSION_LOCAL_GRACE_MS; a socket that
// opens again first clears it. `check()` stops a run past that deadline (or
// its server lease) as `device_lost`, and one that made no progress for
// `stallMs` as `timeout`. Nothing is renewed over HTTP.
//
// Stopping the daemon never waits on an adapter: each run races its next
// session event against an abort signal, and `stop()` gives runs a bounded
// grace period. A session that ignores `cancel()` is detached after
// `CANCEL_GRACE_MS` and the run ends as cancelled (or its forced reason).
//
// Messages (ADR 0018): the run's output is cut into assistant messages with
// `start` / `finish` chunks. A message a person sends to the agent closes the
// one in progress at the next point where no text, reasoning or tool call is
// still open, so the agent's reply starts a new message after theirs; the
// run's end closes the last one. Run-state chunks are transient.
//
// The handoff report's verify result is always the daemon's own: only the
// agent's summary, open questions, next step and blocker are taken from the
// agent. An explicitly approved, pushed submission can finish unverified;
// its report keeps `not_run`, and the server may open only a draft PR.
import { quotaStopApplies } from "./quota-exhausted"
import { runApps, runMcp } from '../agents/run-apps'
import { startTaskSecretBridge, type TaskSecretBridge } from '../task-secret-bridge'
import { taskExecutionEnv } from '../task-env'
import { materializeChatFiles } from '../agents/chat-files'
import { splitChatFiles, type ChatFileDownload } from '@mikka/protocol/chat-attachments'
import { fixedCheckSnapshot } from "./check"
import { verifySkillAssignment, verifySkillResume, verifyMountedSkill } from '../agents/skill-artifact'
import type { SkillReceiptRevalidation } from '@mikka/protocol/skill'
import { runPaths } from "../agents/run-context"
import { removeRunCredentials } from "../run-scratch"
import { createRunMasker, type RunMasker } from "../secret-mask"
import { stdSerializers } from 'pino'
import { SKILLS_DIR, SKILL_BODY_FILE, skillSlug } from "@mikka/protocol/skill"
import { runSkillMount, runExecution, runRuntime } from "@mikka/protocol/run"
import { ProviderFailureError, providerFailureSchema, type ProviderFailure } from "@mikka/protocol/provider-failure"
import { CodedError } from "@mikka/protocol/coded-error"
import { runPolicyDigestInput } from "@mikka/protocol/agent-policy"
import { createHash, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { withRunGitCredentials } from '../agents/github-runtime'

import {
  isTerminalRunState,
  runCheckpointReceiptSchema,
  type HandoffReport,
  type Harness,
  type RunCheckpoint,
  type RunCheckpointReceipt,
  type RunState,
  type RunSummary,
  type StopReason,
} from "@mikka/protocol"

import {
  applyCheckpoint,
  assertCheckpointFresh,
  CheckpointRecoveryError,
  hasCommit,
  headCommit,
  takeCheckpoint,
} from "../agents/checkpoint"
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  StartOptions,
  PreparedAgentStart,
  ExitEvent,
} from "../adapters/types"
import { runStageChunk, runStateChunk, type RunChunk, type RunStage } from "../chunks"
import { buildChildEnv } from "../env"
import { worktreeGitWritePaths } from "../agents/publish"
import {
  HarnessNotSupportedError,
  InvalidIdError,
  InvalidRepositoryError,
  RunNotFoundError,
  type DaemonError,
} from "../errors"
import { isSafeId } from "../ids"
import type { Logger } from "../log"
import type { Outbox, OutboxItem } from "../outbox"
import { pushDecision, runPolicy } from "../permissions"
import {
  DEVICE_SESSION_LOCAL_GRACE_MS,
  type DeviceRepo,
  type RunAssignment,
} from "../server-link"
import type { WorktreeManager } from "../worktrees"
import type { JournalEntry, RunJournal } from "./journal"
import type { ToolApprovalGate } from "../agents/tool-approval"
import type { PreparedRunGitHub } from '../agents/local-github'
import { assertMailboxRunAuthority, mailboxNoticeText, type RunMailbox } from '../run-mailbox'
import type { RunDrive } from '../run-drive'
import { daemonTracer, runIdHash, type DaemonStartupTiming, type SpanHandle } from '../tracing'
import { runDiagnosticsEnabled, runRuntimeTimings, type RunRuntimeObservation, type RunRuntimeTiming } from '../run-runtime-timing'

import { baseReport, finishRun, fixedCandidateCheck, verifyAndPublish, type PublicationDeps } from './publication'
import type { WorkspaceControl } from './workspace-control'

export interface SupervisorDeps extends PublicationDeps {
  acquireWorkspaceControl?(assignment: RunAssignment, signal: AbortSignal, onLost: () => void): Promise<WorkspaceControl>
  /** Trusted candidate launcher opt-in, shared with the official CLI collector. */
  collectCliTiming?: boolean
  downloadChatFile?(assignment: RunAssignment, id: string, signal: AbortSignal): Promise<ChatFileDownload>
  /** Existing authenticated checkpoint route, before terminal completion releases the lease. */
  saveCheckpoint?(runId: string, checkpoint: RunCheckpoint): Promise<RunCheckpointReceipt | void>
  journal: RunJournal
  /** Same adapter state root used by RunContext; never supplied by the model. */
  adapterStateDir?: string
  outbox: Outbox
  worktrees: WorktreeManager
  adapters: ReadonlyMap<Harness, AgentAdapter>
  /** Hosted subscription runs never fall back to local CLI authentication. */
  startSubscription?(assignment:RunAssignment,options:StartOptions):Promise<AgentSession>
  /** Hosted fresh Claude only: no task frame before start consumes final options. */
  prepareSubscription?(assignment: RunAssignment, options: StartOptions, signal: AbortSignal): PreparedAgentStart
  /** The task VM prepares its actual API key and starts the official CLI directly. */
  startCredential?(assignment:RunAssignment,options:StartOptions):Promise<AgentSession>
  prepareRunMailbox?(assignment: RunAssignment, signal: AbortSignal, check: () => void): Promise<RunMailbox | undefined>
  prepareRunDrive?(assignment: RunAssignment, signal: AbortSignal): Promise<RunDrive | undefined>
  /** Fresh policy validation before worktree/setup/agent effects, including resume. */
  verifyRunPolicy?(assignment: RunAssignment, signal: AbortSignal): Promise<unknown>
  prepareRunToolApproval?(assignment: RunAssignment, signal: AbortSignal, check: () => void, worktree?: string): Promise<ToolApprovalGate>
  /** Once per local run, retained through verification and publication. */
  prepareRunGitHub?(assignment: RunAssignment, signal: AbortSignal, onCredential: (name: string, value: string) => void): Promise<PreparedRunGitHub | undefined>
  bootstrap?(worktree:string,repo:DeviceRepo):Promise<string>
  /** Resolve only daemon-owned cache paths (or a trusted hosted workspace). */
  repository: (assignment: RunAssignment) => DeviceRepo
  /** A fresh hosted claim may overlap remote reads with policyReady. Any
   * empty-repository creation/push must await that same authorization. */
  prepareRepository: (assignment: RunAssignment, signal: AbortSignal, githubEnvironment?: Record<string, string>, policyReady?: Promise<unknown>, onRepositoryTiming?: RepositoryTimingObserver) => Promise<void>
  baseRef: (assignment: RunAssignment) => Promise<string>
  log: Logger
  /** Uploads what the run's agent queued with `submit_capture` (`captures.ts`). */
  captures?: { flush(runId: string, existingOnly?: boolean, signal?: AbortSignal): Promise<void> }
  revalidateSkillAssignment?:(assignment:RunAssignment)=>Promise<SkillReceiptRevalidation>
  /** Watchdog: no progress for this long stops the run (`timeout`). */
  stallMs?: number
  /** How long `stop()` waits for runs to let go (default 3 s). */
  stopGraceMs?: number
  /** How long a cancelled session may take to exit (default 10 s). */
  cancelGraceMs?: number
}

const DEFAULT_STALL_MS = 10 * 60_000
const DEFAULT_STOP_GRACE_MS = 3_000
const DEFAULT_CANCEL_GRACE_MS = 10_000
interface ActiveRun {
  workspaceControl?: WorkspaceControl
  secretBridge?: TaskSecretBridge
  runtimeTiming?: RunRuntimeObservation
  github?: PreparedRunGitHub
  toolApproval?: ToolApprovalGate
  /** The run's trace span; its outcome is the stop reason. */
  span?: SpanHandle
  mailbox?: RunMailbox
  /** Shared Drive folders mirrored under ~/.mikka/drive. */
  drive?: RunDrive
  mailboxPreparing?: Promise<RunMailbox | undefined>
  mailboxAbort?: AbortController
  mailboxClosing?: Promise<void>
  /** Only a fresh hosted claim's read-only clone/fetch overlaps entry policy. */
  repositoryPreparing?: { abort: AbortController; done: Promise<void>; allowEffects(): void; refuseEffects(reason: unknown): void }
  sessionPreparing?: Promise<PreparedAgentStart>
  prewarmAbort?: AbortController
  preparedClosing?: Promise<void>
  session: AgentSession | null
  observedModel?: string
  /** Event consumption ended; cancellation grace cannot cover host publication. */
  sessionEnded?: boolean
  /** An actual adapter exit, never an exhausted stream or forced detachment. */
  sessionExited?: boolean
  /** Constructed by this supervisor after finishing work and the final upload. */
  safePoint?: HandoffReport['safePoint']
  cancelRequested: boolean
  /** Set when the watchdog or the lease stopped the run. */
  forcedStop?: StopReason
  lastProgressAt: number
  done: Promise<void>
  /** Also aborts verification and publication immediately after the CLI exits. */
  abort: AbortController
  cancelTimer?: NodeJS.Timeout
  /** The repo checkout the run's worktree belongs to. */
  repoPath: string
  /** A tool call finished since the last checkpoint. */
  checkpointDue?: boolean
  checkpointing?: Promise<boolean>
  lastCheckpointAt?: number
  /** Tree of the last checkpoint taken; unchanged trees are not sent. */
  lastCheckpointTree?: string
  lastCheckpointHead?: string | null
}

/** A run with no tool call in this long still gets a checkpoint when it changed. */
export const CHECKPOINT_EVERY_MS = 2 * 60_000

export class RunSupervisor {
  private active = new Map<string, ActiveRun>()
  /** Server lease expiry per held run (ms); runs without a server lease are absent. */
  private leases = new Map<string, number>()
  /** Set while the device session socket is down: when held runs lose their lease. */
  private sessionDeadline: number | null = null
  private stopping = false
  /** Runs with an assistant message in progress (`start` sent, no `finish`). */
  private openMessages = new Set<string>()
  /** Per run: text / reasoning ids and tool calls still open in that message. */
  private openParts = new Map<string, Set<string>>()
  /** Runs with injected workspace secrets: their output is masked before the outbox (../secret-mask). */
  private maskers = new Map<string, RunMasker>()
  /** Runs whose message ends at the next safe point (a person wrote). */
  private cutMessages = new Set<string>()
  /** Aborted by `stop()`: kills a running verify command. */
  private stopController = new AbortController()
  private blockedSkillResumes = new Set<string>()

  constructor(private readonly deps: SupervisorDeps) {}

  summary(entry: JournalEntry): RunSummary {
    return {
      runId: entry.assignment.runId,
      issueId: entry.assignment.issueId,
      harness: entry.assignment.harness,
      state: entry.state,
      worktree: entry.worktree,
      sessionId: entry.sessionId,
      chunks: entry.lastSeq,
      error: entry.error,
      ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
      ...this.liveness(entry.assignment.runId),
    }
  }

  private liveness(runId: string) {
    const lease = this.leaseExpiry(runId)
    const run = this.active.get(runId)
    return {
      ...(lease !== undefined && Number.isFinite(lease)
        ? { leaseExpiresAt: new Date(lease).toISOString() }
        : {}),
      ...(run
        ? { lastProgressAt: new Date(run.lastProgressAt).toISOString() }
        : {}),
    }
  }

  /**
   * When a held run's local lease ends: its server lease, or the session
   * deadline while the socket is down. Undefined for a run the server never
   * leased (local dev runs); Infinity while the session is open.
   */
  private leaseExpiry(runId: string): number | undefined {
    const lease = this.leases.get(runId)
    if (lease === undefined) return undefined
    return Math.min(lease, this.sessionDeadline ?? Number.POSITIVE_INFINITY)
  }

  /** The device session socket opened: held runs keep their lease while it stays open. */
  sessionOpened() {
    this.sessionDeadline = null
  }

  /**
   * The device session socket is down since `at`. Held runs stop as
   * `device_lost` once it stays down for DEVICE_SESSION_LOCAL_GRACE_MS; a
   * later drop never extends an earlier deadline.
   */
  sessionClosed(at = Date.now()) {
    if (this.sessionDeadline !== null) return
    this.sessionDeadline = at + DEVICE_SESSION_LOCAL_GRACE_MS
  }

  /**
   * Saves the work in progress of runs that had a tool call since their last
   * checkpoint, or none for `CHECKPOINT_EVERY_MS`, through `save`. The
   * daemon calls it from its local timer while the device session is open;
   * a tree that did not change since the last checkpoint is not sent, so an
   * idle run makes no request. A failed save is tried again on the next call.
   */
  async saveCheckpoints(
    save: (runId: string, checkpoint: RunCheckpoint) => Promise<RunCheckpointReceipt | void>,
    now = Date.now(),
  ) {
    for (const [runId, run] of this.active) {
      const entry = this.deps.journal.get(runId)
      if (!entry?.worktree || !entry.baseCommit || run.checkpointing) continue
      if (run.sessionEnded || run.forcedStop || run.cancelRequested) continue
      const since = run.lastCheckpointAt ?? run.lastProgressAt
      if (!run.checkpointDue && now - since < CHECKPOINT_EVERY_MS) continue
      await this.saveCheckpoint(runId, run, save, now)
    }
  }

  private async saveCheckpoint(runId: string, run: ActiveRun,
    save: (runId: string, checkpoint: RunCheckpoint) => Promise<RunCheckpointReceipt | void>, now = Date.now(), force = false): Promise<boolean> {
    // A periodic save may already be uploading an older tree. Its upload must
    // finish before the terminal one, so it cannot overwrite the final state.
    if (run.checkpointing) await run.checkpointing
    const entry = this.deps.journal.get(runId)
    if (!entry?.worktree || !entry.baseCommit || run.forcedStop || run.cancelRequested || this.stopping) return false
    const { worktree, baseCommit } = entry
    const pending = (async () => {
      try {
        const taken = await takeCheckpoint({
          repoPath: run.repoPath,
          worktree,
          baseCommit,
          // A terminal upload also refreshes an unchanged/empty snapshot. A
          // much older identical tree would fail the server's freshness gate.
          lastTree: force ? undefined : run.lastCheckpointTree,
          lastHead: force ? undefined : run.lastCheckpointHead,
          repoId: entry.assignment.repoId,
        })
        const masker = this.maskers.get(runId)
        const checkpoint = taken?.checkpoint ? masker ? masker.checkpoint(taken.checkpoint) : taken.checkpoint : undefined
        if (checkpoint) await save(runId, checkpoint)
        // Drive changes go up with each checkpoint; a refusal never fails the checkpoint.
        if (checkpoint) await run.drive?.push()
        if (taken) { run.lastCheckpointTree = taken.tree; run.lastCheckpointHead = taken.head }
        run.checkpointDue = false
        run.lastCheckpointAt = now
        return checkpoint ? !checkpoint.unavailableReason : !force
      } catch (error) {
        this.deps.log.warn({ run_id: runId, err: this.logError(runId, error) }, "checkpoint failed")
        return false
      }
    })()
    run.checkpointing = pending
    try { return await pending }
    finally { if (run.checkpointing === pending) run.checkpointing = undefined }
  }

  private async saveTerminalCheckpoint(runId: string, run: ActiveRun, finishingComplete = false): Promise<Pick<NonNullable<HandoffReport['safePoint']>, 'checkpoint' | 'checkpointTakenAt'>> {
    // Even an older uploaded snapshot cannot stand in for this final tree.
    // The server may continue an unavailable one only in its original worktree.
    run.safePoint = undefined
    let receipt: RunCheckpointReceipt | undefined
    const save = this.deps.saveCheckpoint
    const ready = save && await this.saveCheckpoint(runId, run, async (id, checkpoint) => {
      const accepted = runCheckpointReceiptSchema.safeParse(await save(id, checkpoint))
      if (accepted.success && accepted.data.runId === id) receipt = accepted.data
    }, Date.now(), true)
    // The final Drive changes, whatever the worktree's checkpoint did.
    if (!this.stopping) await run.drive?.push()
    const checkpoint = ready && receipt
      ? { checkpoint: 'ready' as const, checkpointTakenAt: receipt.takenAt }
      : { checkpoint: 'unavailable' as const }
    // The synthetic cancelled/error exits used to detach a stuck adapter
    // cannot establish that the native process stopped writing its workspace.
    if (finishingComplete && run.sessionExited && !this.stopping)
      // Native exit precedes the final upload. Its server acknowledgement
      // establishes that order even when the device's clock is ahead or behind.
      run.safePoint = { session: 'exited', observedAt: receipt?.takenAt ?? new Date().toISOString(), ...checkpoint }
    return checkpoint
  }

  /** Local lease and watchdog pass; the daemon calls it from its local timer (no request). */
  check(now = Date.now()) {
    const stallMs = this.deps.stallMs ?? DEFAULT_STALL_MS
    for (const [runId, run] of this.active) {
      if (run.forcedStop) continue
      const lease = this.leaseExpiry(runId)
      if (lease !== undefined && now > lease) {
        this.forceStop(runId, run, "device_lost")
      } else if (now - run.lastProgressAt > stallMs) {
        this.forceStop(runId, run, "timeout")
      }
    }
  }

  private forceStop(runId: string, run: ActiveRun, reason: StopReason) {
    this.deps.log.warn({ run_id: runId, stop_reason: reason }, "stopping run")
    run.forcedStop = reason
    this.requestCancel(runId, run)
  }

  private closeMailbox(run: ActiveRun): Promise<void> {
    if (!run.mailbox && !run.mailboxPreparing) return Promise.resolve()
    if (!run.mailboxClosing) {
      if (run.mailboxPreparing) {
        // Own a late handoff before closing it. Publish the drain before
        // abort callbacks can re-enter; a failed preparation has no mailbox.
        run.mailboxClosing = run.mailboxPreparing.then(() => run.mailbox?.close(), () => undefined)
        run.mailboxAbort?.abort()
      } else {
        try { run.mailboxClosing = run.mailbox!.close() }
        catch (error) { run.mailboxClosing = Promise.reject(error) }
      }
    }
    return run.mailboxClosing
  }

  private closePrepared(run: ActiveRun): Promise<void> {
    if (!run.sessionPreparing) return Promise.resolve()
    if (!run.preparedClosing) run.preparedClosing = run.sessionPreparing.then(value => value.cancel(), () => undefined)
    run.prewarmAbort?.abort()
    // Preparation may still be joining the mailbox. Abort that dependency
    // before draining it; the mailbox finalizer still owns its close result.
    run.mailboxAbort?.abort()
    return run.preparedClosing
  }

  /** Asks the session to stop; detaches it if it does not within the grace. */
  private requestCancel(runId: string, run: ActiveRun): Promise<void> {
    run.cancelRequested = true
    // Read-ahead Git has its own lifetime and stops immediately, without
    // borrowing the native session's cancellation grace.
    run.repositoryPreparing?.abort.abort()
    run.prewarmAbort?.abort()
    run.toolApproval?.revoke()
    // Fence new calls and abort outstanding transport immediately; do not
    // leave a mailbox usable during the CLI's cancellation grace period.
    void this.closeMailbox(run).catch(() => this.deps.log.warn('Run mailbox shutdown failed'))
    if (run.sessionEnded) {
      clearTimeout(run.cancelTimer)
      run.abort.abort()
    } else if (!run.cancelTimer) {
      run.cancelTimer = setTimeout(
        () => run.abort.abort(),
        this.deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      )
      run.cancelTimer.unref()
    }
    return Promise.resolve(run.session?.cancel()).catch((error: unknown) => {
      this.deps.log.warn({ run_id: runId, err: this.logError(runId, error) }, "session cancel failed")
    })
  }

  list(): RunSummary[] {
    return this.deps.journal.all().map((entry) => this.summary(entry))
  }

  get(runId: string): RunSummary {
    const entry = this.deps.journal.get(runId)
    if (!entry) throw new RunNotFoundError(runId)
    return this.summary(entry)
  }

  /**
   * Removes the worktree and branches of an ended run when it, and every run
   * sharing its worktree, ended without a reason to keep them and left
   * nothing behind (see `WorktreeManager.discardIfEmpty`). `cancelledRunId`
   * is a run the server cancelled although its daemon had parked it on a
   * question. A run that never got a worktree only loses its branch.
   */
  async discardIfEmpty(
    runId: string,
    cancelledRunId?: string,
  ): Promise<boolean> {
    const entry = this.deps.journal.get(runId)
    if (!entry) return false
    const worktree = entry.worktree
    const group = worktree
      ? this.deps.journal.all().filter((e) => e.worktree === worktree)
      : [entry]
    const discardable = group.every((e) => {
      if (!isTerminalRunState(e.state)) return false
      if (e.assignment.runId === cancelledRunId) return true
      if (e.waitingQuestionId) return false
      // A verified hand-in is under review; its work is published.
      if (e.state === "succeeded") return false
      if (e.assignment.preserveQuestionWorktree && e.stopReason === "blocked") return false
      return !e.stopReason || !KEEP_WORKTREE.includes(e.stopReason)
    })
    if (!discardable) return false
    let repo: DeviceRepo
    try { repo = this.deps.repository(entry.assignment) } catch { return false }
    return this.discard(
      group.map((e) => e.assignment.runId),
      worktree,
      repo.path,
      runId,
    )
  }

  /**
   * A run branch the journal knows nothing about (an earlier data dir, a
   * crash before the journal was written): removed when it is empty.
   */
  async discardOrphan(
    runId: string,
    worktree: string | null,
    repoPath: string,
  ): Promise<boolean> {
    if (this.deps.journal.get(runId)) return false
    return this.discard([runId], worktree, repoPath, runId)
  }

  private async discard(
    runIds: string[],
    worktree: string | null,
    repoPath: string,
    logRunId: string,
  ): Promise<boolean> {
    try {
      const removed = await this.deps.worktrees.discardIfEmpty(
        runIds,
        worktree,
        repoPath,
      )
      if (removed)
        this.deps.log.info(
          { run_id: logRunId },
          "removed the empty worktree and branches",
        )
      return removed
    } catch (err) {
      this.deps.log.warn({ run_id: logRunId, err: this.logError(logRunId, err) }, "could not clean up")
      return false
    }
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }

  /** Computer operations require a live run and a current local lease. */
  computerRunAllowed(runId: string): boolean {
    const run = this.active.get(runId)
    const lease = this.leaseExpiry(runId)
    return !this.stopping && Boolean(run && !run.cancelRequested && lease !== undefined && lease > Date.now())
  }

  /**
   * Starts a claimed run. Its remote is validated before any worktree or
   * process exists; repositories need no device registration.
   */
  start(assignment: RunAssignment): RunSummary {
    // The run id names the worktree, the branch and the outbox file; one
    // that could leave those dirs is refused before anything touches disk.
    // The caller reports it to the server (it has no outbox to go through).
    if (!isSafeId(assignment.runId)) {
      throw new InvalidIdError(
        `Refusing run id ${JSON.stringify(assignment.runId)}: only letters, digits, "_" and "-" (1-64 characters)`,
        { runId: assignment.runId },
      )
    }
    const existing = this.deps.journal.get(assignment.runId)
    if (existing) return this.summary(existing)
    // 4e3: mask the task's injected secrets (names from the server, values from taskEnv) before upload.
    const masker = createRunMasker([...(assignment.taskSecretNames ?? []).flatMap(name => {
      const value = assignment.taskEnv?.[name]
      return typeof value === "string" ? [{ name, value }] : []
    }), ...(assignment.modelCredential ? [{ name: "MODEL_API_KEY", value: assignment.modelCredential.key }] : []),
      ...(assignment.subscriptionLease ? [{ name: "SUBSCRIPTION_ACCESS_TOKEN", value: assignment.subscriptionLease.accessToken }] : []),
      ...(assignment.github?.token ? [{ name: "GITHUB_TOKEN", value: assignment.github.token }] : []),
      ...taskMcpSecretValues(assignment.mcp?.servers).map(value => ({name:'MCP_CREDENTIAL',value})),
      ...(assignment.taskSecrets?.grants.map(grant => ({ name: 'TASK_SECRET_CAPABILITY', value: grant.capability })) ?? []),
    ])
    if (masker) this.maskers.set(assignment.runId, masker)
    let repo: DeviceRepo
    try { repo = this.deps.repository(assignment) } catch (error) {
      this.refuse(assignment, new InvalidRepositoryError(error instanceof Error ? error.message : undefined))
    }
    if (!this.deps.adapters.has(assignment.harness)) {
      this.refuse(assignment, new HarnessNotSupportedError(assignment.harness))
    }
    this.deps.journal.put({
      assignment,
      state: "queued",
      sessionId: null,
      worktree: null,
      lastSeq: 0,
      error: null,
      updatedAt: new Date().toISOString(),
    })
    if (assignment.computer) {
      const task = assignment.prompt.split('\n')[0].replace(/^#\s*/, '').trim().slice(0, 200) || 'Task'
      this.emit(assignment.runId, { type: 'data-computer', data: { botId: assignment.computer.botId, runId: assignment.runId, task, state: 'working' } })
    }
    if (assignment.leaseExpiresAt)
      this.leases.set(assignment.runId, Date.parse(assignment.leaseExpiresAt))
    this.launch(assignment.runId, repo, true)
    return this.get(assignment.runId)
  }

  /** A claimed run this daemon cannot take: failed, with one completion. */
  private refuse(assignment: RunAssignment, error: DaemonError): never {
    this.flushMasker(assignment.runId)
    this.push(assignment.runId, {
      kind: "run",
      patch: { state: "failed", error: error.message, stopReason: "error" },
    })
    this.push(assignment.runId, {
      kind: "complete",
      completion: { stopReason: "error", report: baseReport(error.message), failureDetails: captureRunFailure(error, { runId: assignment.runId, appVersion: DAEMON_VERSION, sensitiveText: [assignment.prompt] }) },
    })
    this.disposeMasker(assignment.runId)
    throw error
  }

  /** The server refused this run's completion for good (outbox 4xx). */
  markUndeliverable(runId: string, error: unknown) {
    if (!this.deps.journal.get(runId)) return
    const message = error instanceof Error ? error.message : String(error)
    this.deps.journal.update(runId, {
      error: `The server refused this run's completion: ${message}`,
    })
  }

  /** Picks up every non-terminal run from the journal after a restart. */
  async resumeAll(receiptedOnly=false) {
    const entries=this.deps.journal.active().sort((a,b)=>Number(Boolean(a.assignment.skillReceipt))-Number(Boolean(b.assignment.skillReceipt)))
    for (const entry of entries) {
      if (this.stopping) return
      if (receiptedOnly && !this.blockedSkillResumes.has(entry.assignment.runId)) continue
      if (this.active.has(entry.assignment.runId)) continue
      // A crash between the outbox append and the journal write leaves the
      // outbox one chunk ahead; continue after it so seqs neither repeat nor gap.
      const outboxSeq = this.deps.outbox.lastChunkSeq(entry.assignment.runId)
      if (outboxSeq > entry.lastSeq)
        this.deps.journal.update(entry.assignment.runId, { lastSeq: outboxSeq })
      let repo: DeviceRepo
      try { repo = this.deps.repository(entry.assignment) } catch {
        this.finish(entry.assignment.runId, 'error', 'Repository unavailable; dispatch a new thread with a repository URL.')
        continue
      }
      if (entry.taskSecretsWithheld && !entry.assignment.taskSecrets && !entry.assignment.taskEnv) {
        this.finish(entry.assignment.runId, 'blocked', 'task_secret_unavailable')
        continue
      }
      if (entry.assignment.skillReceipt) {
        // An interrupted finishing/publication window needs the existing
        // explicit reconciliation path; online access is not permission to
        // replay an uncertain external effect.
        if (entry.state==='finishing') {
          this.deps.journal.update(entry.assignment.runId,{error:'Skill resume blocked: interrupted finishing requires explicit reconciliation.'})
          continue
        }
        try {
          if (!this.deps.revalidateSkillAssignment) throw new Error('Current Skill source check unavailable')
          const current=await this.deps.revalidateSkillAssignment(entry.assignment)
          if (this.stopping) return
          const latest=this.deps.journal.get(entry.assignment.runId)
          if (!latest||isTerminalRunState(latest.state)||this.active.has(entry.assignment.runId)) {
            this.blockedSkillResumes.delete(entry.assignment.runId)
            continue
          }
          if (latest.state!==entry.state||latest.sessionId!==entry.sessionId||latest.worktree!==entry.worktree||latest.assignment.skillReceipt?.id!==entry.assignment.skillReceipt.id)
            throw new Error('Local Skill resume fence changed')
          this.leases.set(entry.assignment.runId,Date.parse(verifySkillResume(entry.assignment,current)))
          this.deps.journal.update(entry.assignment.runId,{error:null})
          this.blockedSkillResumes.delete(entry.assignment.runId)
          this.launch(entry.assignment.runId,repo)
        } catch {
          const latest=this.deps.journal.get(entry.assignment.runId)
          if (!latest||isTerminalRunState(latest.state)) {this.blockedSkillResumes.delete(entry.assignment.runId);continue}
          this.leases.delete(entry.assignment.runId)
          this.blockedSkillResumes.add(entry.assignment.runId)
          this.deps.journal.update(entry.assignment.runId,{error:'Skill resume blocked: current online source, authorization and lease required.'})
        }
        continue
      }
      // The run's API key was never written down; it does not go on without it.
      if (entry.credentialWithheld && !entry.assignment.modelCredential) {
        this.finish(entry.assignment.runId, 'error', 'The run stopped with the daemon; its API key is not kept. Retry the thread.')
        continue
      }
      // Held again while the session lasts: it must open within the local
      // grace (sessionClosed at startup), and its first read delivers the
      // stop for a run the server took back meanwhile.
      if (entry.assignment.leaseExpiresAt)
        this.leases.set(entry.assignment.runId, Number.POSITIVE_INFINITY)
      this.launch(entry.assignment.runId, repo)
    }
  }

  /** Notify an existing authorized session; never start or resume a task. */
  async notifyMailbox(runId: string, messageIds: readonly string[]) {
    const run = this.active.get(runId)
    if (!run?.session || !run.mailbox || !run.toolApproval || !run.mailbox.tools.some(tool => tool.name === 'mailbox_inbox'))
      throw new RunNotFoundError(runId)
    const state = this.deps.journal.get(runId)?.state
    if (state !== 'running' && state !== 'waiting_input') throw new RunNotFoundError(runId)
    const check = () => assertMailboxRunAuthority({ held: this.active.get(runId) === run,
      state: this.deps.journal.get(runId)?.state,
      stopped: this.stopping || run.cancelRequested || run.abort.signal.aborted,
      lease: this.leaseExpiry(runId) })
    check()
    // This fixed notice grants no action authority. Avoid waiting on a human
    // control handback here, which would block the same poll's stop channel.
    // Reading the inbox and every subsequent tool still use their live gate.
    if (run.toolApproval.revoked) throw new Error('Run mailbox unavailable')
    check()
    await this.send(runId, mailboxNoticeText(runId, messageIds))
  }

  async send(runId: string, text: string, mode?: "steer") {
    const run = this.active.get(runId)
    const adapter = this.adapterFor(runId)
    if (!run?.session) throw new RunNotFoundError(runId)
    if (mode === "steer" && adapter.harness !== "codex") throw new Error("Active turn steering unavailable")
    if (!adapter.capabilities.supportsInterject) {
      throw new Error(
        `Harness "${adapter.harness}" cannot take messages mid-run`,
      )
    }
    // The agent's answer to this goes in a new message, after the person's.
    if (this.openMessages.has(runId)) this.cutMessages.add(runId)
    const entry = this.deps.journal.get(runId)
    if (splitChatFiles(text).files.length) {
      if (!entry || !this.deps.downloadChatFile || !this.deps.adapterStateDir) throw Error('Run attachments unavailable')
      text = await materializeChatFiles(text, join(this.deps.adapterStateDir, 'inputs', runId), id => this.deps.downloadChatFile!(entry.assignment, id, run.abort.signal))
    }
    await run.session.send(text, mode)
  }

  async cancel(runId: string): Promise<RunSummary> {
    const entry = this.deps.journal.get(runId)
    if (!entry) throw new RunNotFoundError(runId)
    const run = this.active.get(runId)
    if (run) {
      await this.requestCancel(runId, run)
      await run.done
    } else if (!isTerminalRunState(entry.state)) {
      this.finish(runId, "cancelled")
    }
    return this.get(runId)
  }

  /**
   * Stops consuming sessions without ending runs; they resume on next boot.
   * Never waits on an adapter longer than the grace period.
   */
  async stop() {
    this.stopping = true
    this.stopController.abort()
    const runs = [...this.active.values()]
    for (const run of runs) {
      run.toolApproval?.revoke()
      clearTimeout(run.cancelTimer)
      run.abort.abort()
    }
    let timer: NodeJS.Timeout | undefined
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        this.deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      )
    })
    await Promise.race([Promise.all(runs.map((run) => run.done)), grace])
    clearTimeout(timer)
  }

  /** Resolves when every active run has reached a terminal state (tests). */
  async idle() {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((run) => run.done))
    }
  }

  private adapterFor(runId: string): AgentAdapter {
    const entry = this.deps.journal.get(runId)
    if (!entry) throw new RunNotFoundError(runId)
    return this.deps.adapters.get(entry.assignment.harness) as AgentAdapter
  }

  /**
   * Adds message boundaries around `chunk` (see the header), then appends
   * it to the run's stream.
   */
  private emit(runId: string, chunk: RunChunk) {
    this.active.get(runId)?.runtimeTiming?.chunk(chunk)
    if (
      chunk.type.startsWith("data-") &&
      "transient" in chunk &&
      chunk.transient
    )
      return this.append(runId, chunk)
    const open = this.openParts.get(runId) ?? new Set<string>()
    this.openParts.set(runId, open)
    if (this.cutMessages.has(runId) && open.size === 0) this.endMessage(runId)
    trackParts(open, chunk)
    if (chunk.type === "start") {
      this.endMessage(runId)
      this.openMessages.add(runId)
    } else if (chunk.type === "finish") {
      if (!this.openMessages.has(runId)) return
      this.openMessages.delete(runId)
      this.cutMessages.delete(runId)
      open.clear()
    } else if (!this.openMessages.has(runId)) {
      this.append(runId, { type: "start", messageId: randomUUID() })
      this.openMessages.add(runId)
    }
    this.append(runId, chunk)
  }

  /**
   * The two cards a planning hand-in leaves in the conversation: the spec,
   * and the split that follows it. The split is a proposal — a person
   * approves it before any issue exists (ADR ORV-205).
   */
  private emitPlanCards(
    runId: string,
    report: HandoffReport,
    planning: boolean,
  ) {
    const plan = planning ? report.plan : undefined
    if (!plan) return
    this.emit(runId, {
      type: "data-spec",
      data: {
        specId: plan.specId,
        title: plan.spec.title,
        summary: plan.spec.summary,
        sections: plan.spec.sections,
      },
    })
    this.emit(runId, {
      type: "data-split",
      data: {
        specId: plan.specId,
        summary: plan.split.summary,
        issues: plan.split.issues.map((issue) => ({
          key: issue.key,
          title: issue.title,
          note: issue.goal ?? "",
          criteria: issue.criteria.map((criterion) => criterion.body),
          blockedBy: issue.blockedBy,
          ...(issue.parentKey ? { parentKey: issue.parentKey } : {}),
        })),
      },
    })
  }

  /** Closes the run's message in progress, if any. */
  private endMessage(runId: string, runtimeTiming?: RunRuntimeTiming) {
    this.cutMessages.delete(runId)
    this.openParts.get(runId)?.clear()
    if (this.openMessages.delete(runId)) this.append(runId, { type: "finish", ...(runtimeTiming ? { messageMetadata: { mikkaRuntimeTiming: runtimeTiming } } : {}) })
  }

  /** Outbox first, then the journal: see `resumeAll` for the reconcile. Masked first when the run has secrets. */
  private append(runId: string, chunk: RunChunk) {
    const masker = this.maskers.get(runId)
    for (const out of masker ? masker.chunk(chunk) : [chunk]) {
      const seq = (this.deps.journal.get(runId)?.lastSeq ?? 0) + 1
      this.deps.outbox.push(runId, { kind: "chunk", seq, chunk: out })
      this.deps.journal.update(runId, { lastSeq: seq })
    }
  }

  /** Every run patch and completion goes through here: masked before it is written to the outbox. */
  private push(runId: string, item: Exclude<OutboxItem, { kind: "chunk" }>) {
    const masker = this.maskers.get(runId)
    this.deps.outbox.push(runId, masker ? masker.deep(item) : item)
  }

  /** Releases any held-back text, masked, as chunks (before the run's terminal items). */
  private flushMasker(runId: string) {
    for (const chunk of this.maskers.get(runId)?.flush() ?? []) {
      const seq = (this.deps.journal.get(runId)?.lastSeq ?? 0) + 1
      this.deps.outbox.push(runId, { kind: "chunk", seq, chunk })
      this.deps.journal.update(runId, { lastSeq: seq })
    }
  }

  /** Forgets the run's secret values once its last item is in the outbox. */
  private disposeMasker(runId: string) {
    this.maskers.get(runId)?.dispose()
    this.maskers.delete(runId)
  }

  private addCredential(runId: string, name: string, value: string) {
    const masker = this.maskers.get(runId)
    if (masker) masker.add([{ name, value }])
    else {
      const created = createRunMasker([{ name, value }])
      if (created) this.maskers.set(runId, created)
    }
  }

  /** Serialize Errors before masking so non-enumerable message/stack/cause
   * fields cannot bypass the same dynamic credential set as run output. */
  private logError(runId: string, error: unknown) {
    // Captured provider exceptions can retain raw SDK causes in memory. Log
    // only their registered identity and bounded cause fields, never messages.
    const failure = failureFrom(error)
    if (failure) return { code: failure.code, ...(failure.detail ? { detail: failure.detail } : {}), causes: failure.causes }
    const masker = this.maskers.get(runId)
    if (!masker) return error
    const seen = new WeakSet<object>()
    const plain = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
      // Pino's serialized Errors have a custom prototype; normalize nested
      // errors too so the JSON-value masker sees message, stack and causes.
      const serialized = value instanceof Error ? stdSerializers.err(value) : value
      return Array.isArray(serialized) ? serialized.map(plain)
        : Object.fromEntries(Object.entries(serialized).map(([key, item]) => [key, plain(item)]))
    }
    return masker.deep(plain(error))
  }

  /**
   * The only way into a terminal state: the terminal patch, then exactly one
   * completion for the server, then the outbox is compacted.
   */
  private finish(
    runId: string,
    stopReason: StopReason,
    error?: string,
    report?: HandoffReport,
    failureDetails?: RunFailure,
  ) {
    this.active.get(runId)?.toolApproval?.revoke()
    const active = this.active.get(runId)
    finishRun({
      runId,
      journal: this.deps.journal,
      active,
      closeOutput: (report, planning) => {
        this.emitPlanCards(runId, report, planning)
        this.endMessage(runId, this.active.get(runId)?.runtimeTiming?.finish())
        this.flushMasker(runId)
        this.openParts.delete(runId)
      },
      setState: (state, extra) => this.setState(runId, state, extra),
      complete: (completion) => this.push(runId, { kind: "complete", completion }),
    }, stopReason, error, report, failureDetails)
    this.cleanupFinishedRun(runId)
  }

  private cleanupFinishedRun(runId: string) {
    this.disposeMasker(runId)
    const run = this.active.get(runId)
    if (run) void this.closeMailbox(run).catch(() => this.deps.log.warn('Run mailbox shutdown failed'))
    this.leases.delete(runId)
    // A finished turn keeps no credential on the machine (decision 2026-10-31-2225);
    // a resumed session writes its own again.
    if (this.deps.adapterStateDir) {
      try { removeRunCredentials(this.deps.adapterStateDir, runId) }
      catch (err) { this.deps.log.warn({ run_id: runId, err }, "run credential cleanup failed") }
    }
    this.deps.outbox.compact(runId).catch((err: unknown) => {
      this.deps.log.error({ run_id: runId, err }, "outbox compaction failed")
    })
  }

  /**
   * Runs one start-up stage and records it as a stored `data-run-stage`
   * chunk with its duration, ok or not, so a run that fails while starting
   * shows which stage it reached. The stage's own result or error passes
   * through unchanged.
   */
  private async stage<T>(runId: string, stage: RunStage, work: (onRepositoryTiming?: RepositoryTimingObserver) => Promise<T>, reportAfter?: Promise<unknown>, prepared?: PreparedAgentStart): Promise<T> {
    const started = performance.now()
    const attributes = { "mikka.run.id_hash": runIdHash(runId), "mikka.harness": this.deps.journal.get(runId)?.assignment.harness }
    let startupTiming: DaemonStartupTiming | undefined
    let repositoryTiming: RepositoryGitTiming | undefined
    const onRepositoryTiming: RepositoryTimingObserver | undefined = stage === 'repository' && this.active.get(runId)?.runtimeTiming
      ? timing => { if (timing.runIdHash === attributes['mikka.run.id_hash'] && timing.harness === attributes['mikka.harness']) repositoryTiming = timing }
      : undefined
    const preparationTiming = () => {
      const timing = this.active.get(runId)?.runtimeTiming && prepared?.preparationTiming
      return timing?.runIdHash === attributes['mikka.run.id_hash'] && timing.harness === attributes['mikka.harness'] ? timing : undefined
    }
    try {
      const value = await daemonTracer.span(stage === "agent_start" ? "daemon.adapter.start" : `daemon.run.${stage}`, attributes, () => work(onRepositoryTiming),
        this.active.get(runId)?.runtimeTiming ? { onStartupTiming: timing => { startupTiming = timing } } : undefined)
      const elapsed = performance.now() - started
      // Repository reads can finish before policy. Preserve their actual
      // duration, but produce no speculative stage/user message before it.
      if (reportAfter) await reportAfter
      if (stage === "agent_start") this.active.get(runId)?.runtimeTiming?.executing()
      this.emit(runId, runStageChunk(stage, elapsed, true, startupTiming, preparationTiming(), repositoryTiming))
      return value
    } catch (error) {
      const elapsed = performance.now() - started
      if (reportAfter) await reportAfter
      this.emit(runId, runStageChunk(stage, elapsed, false, startupTiming, preparationTiming(), repositoryTiming))
      throw error
    }
  }

  private setState(
    runId: string,
    state: RunState,
    extra: {
      sessionId?: string
      worktree?: string
      error?: string
      stopReason?: StopReason
    } = {},
  ) {
    if (extra.error !== undefined) extra = { ...extra, error: this.maskers.get(runId)?.text(extra.error) ?? extra.error }
    const entry = this.deps.journal.update(runId, {
      state,
      ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
      ...(extra.worktree !== undefined ? { worktree: extra.worktree } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.stopReason !== undefined
        ? { stopReason: extra.stopReason }
        : {}),
    })
    this.emit(runId, runStateChunk(state, extra.error, extra.stopReason))
    this.push(runId, {
      kind: "run",
      patch: {
        state,
        sessionId: entry.sessionId,
        worktree: entry.worktree,
        error: entry.error,
        ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
      },
    })
  }

  /** One minute for preparation and upload; cancellation drains before the terminal event. */
  private async flushCaptures(runId: string, signal: AbortSignal): Promise<boolean> {
    if (!this.deps.captures) return true
    const deadline = new AbortController()
    const finishing = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new Error('Capture finalization deadline exceeded')), 60_000)
    try {
      await this.deps.captures.flush(runId, false, finishing)
      finishing.throwIfAborted()
      return true
    } catch (error) {
      if (signal.aborted) return false
      throw error
    } finally { clearTimeout(timer) }
  }

  /** Only the local lease and pushed stop state govern host finishing work. */
  private assertFinishingRunLive(runId: string, signal: AbortSignal) {
    const run = this.active.get(runId)
    const lease = this.leaseExpiry(runId)
    if (run && !run.forcedStop && lease !== undefined && lease <= Date.now())
      this.forceStop(runId, run, "device_lost")
    signal.throwIfAborted()
  }

  /**
   * Where a fresh worktree starts: the issue's branch on the remote when
   * the run pushes there (ADR 0024), so it builds on what earlier runs and
   * people pushed; the base branch when that branch is not there yet or
   * cannot be fetched.
   */
  private async startPoint(
    runId: string,
    repo: DeviceRepo,
    assignment: RunAssignment,
  ): Promise<string> {
    // Factory checks and benchmark replays use an immutable commit, never a
    // remote branch named after that SHA or a later issue-branch head.
    const fixed = fixedCandidateCheck(assignment) ? assignment.baseBranch : assignment.benchmark?.sourceCommit
    if (fixed) {
      if (!/^[a-f0-9]{40}$/.test(fixed) || !await hasCommit(repo.path, fixed))
        throw new Error("Fixed execution commit is unavailable in the repository cache")
      return fixed
    }
    // Taking over a run from another machine: start where it started.
    const resume = assignment.resumeFrom?.baseCommit
    if (resume) {
      assertCheckpointFresh(assignment.resumeFrom!)
      if (await hasCommit(repo.path, resume)) return resume
      throw new CheckpointRecoveryError('Checkpoint base commit is unavailable. Restore the original worktree before retrying.')
    }
    const branch = assignment.pushBranch
    const base = await this.deps.baseRef(assignment)
    if (!branch || !pushDecision(runPolicy(assignment.policy)).push) return base
    try {
      return await withRunGitCredentials(assignment, runPaths(this.deps.adapterStateDir ?? join(tmpdir(), "mikka-run-state"), runId).privateDir,
        env => this.deps.worktrees.fetchBranch(
          repo.path,
          repo.push?.remote ?? "origin",
          branch,
          runId,
          env,
        ), this.active.get(runId)?.github?.env)
    } catch (error) {
      this.deps.log.info(
        { run_id: runId, branch, err: error },
        "issue branch not fetched; starting from the base branch",
      )
      return base
    }
  }

  private launch(runId: string, repo: DeviceRepo, initialClaim = false) {
    const run: ActiveRun = {
      repoPath: repo.path,
      session: null,
      cancelRequested: false,
      lastProgressAt: Date.now(),
      done: Promise.resolve(),
      abort: new AbortController(),
    }
    this.active.set(runId, run)
    const assignment = this.deps.journal.get(runId)?.assignment
    const harness = assignment?.harness
    if (assignment && runDiagnosticsEnabled(assignment.taskEnv, this.deps.collectCliTiming))
      run.runtimeTiming = runRuntimeTimings.begin(runId, assignment.deviceId, assignment.harness)
    run.done = daemonTracer.span("daemon.run", { "mikka.run_id": runId, "mikka.run.id_hash": runIdHash(runId), "mikka.harness": harness }, span => {
      run.span = span
      return this.drive(runId, repo, run, initialClaim)
    }, { root: true, traceContext: assignment?.traceContext })
      .catch(async (error: unknown) => {
        run.repositoryPreparing?.refuseEffects(error)
        run.repositoryPreparing?.abort.abort()
        // A failed report/verify bypasses the normal final flush. Cancel and
        // drain earlier capture work before its terminal event closes uploads.
        // Start the independent drains together: native preparation can still
        // be waiting on its mailbox while the Git child is being reaped.
        await Promise.all([run.repositoryPreparing?.done.catch(() => undefined), this.closePrepared(run),
          Promise.resolve().then(() => this.deps.captures?.flush(runId, false,
            AbortSignal.abort(new Error('Capture finalization cancelled')))).catch(() => undefined),
        ])
        run.runtimeTiming?.finishing()
        const message = error instanceof Error ? error.message : String(error)
        this.deps.log.error({ run_id: runId, err: this.logError(runId, error) }, "run failed")
        if (this.stopping) return
        try {
          const providerFailure = run.cancelRequested ? undefined : startupProviderFailure(error)
          const checkpoint = await this.saveTerminalCheckpoint(runId, run)
          if (this.stopping) return
          this.finish(runId,
            run.cancelRequested ? run.forcedStop ?? "cancelled" : providerFailure ? "provider_failure" : error instanceof CheckpointRecoveryError ? 'blocked' : "error",
            run.cancelRequested ? undefined : message,
            { ...baseReport(run.cancelRequested ? undefined : message), ...(providerFailure ? { providerFailure, providerCheckpoint: checkpoint.checkpoint } : {}) },
            captureRunFailure(error, { runId, appVersion: DAEMON_VERSION, sensitiveText: [assignment?.prompt ?? ""] }),
          )
        } catch (finishError) {
          this.deps.log.error(
            { run_id: runId, err: this.logError(runId, finishError) },
            "could not record the run's end",
          )
        }
      })
      .finally(async () => {
        run.secretBridge?.close()
        run.repositoryPreparing?.abort.abort()
        await Promise.all([run.repositoryPreparing?.done.catch(() => undefined), this.closePrepared(run)])
        run.toolApproval?.revoke()
        try { await this.closeMailbox(run) }
        catch { this.deps.log.warn('Run mailbox shutdown failed') }
        finally {
          try { run.github?.close() }
          catch { this.deps.log.warn('GitHub credential cleanup failed') }
          finally {
            await run.workspaceControl?.release(Boolean(run.sessionExited && !this.stopping))
              .catch(() => this.deps.log.warn('Workspace control cleanup failed'))
            clearTimeout(run.cancelTimer); run.runtimeTiming?.close(); this.active.delete(runId)
            // Start draining all three telemetry queues before an idle cloud VM
            // can pause; the completed run never waits for the collector.
            void daemonTracer.flush()
          }
        }
      })
  }

  private async drive(runId: string, repo: DeviceRepo, run: ActiveRun, initialClaim: boolean) {
    const log = this.deps.log.child({ run_id: runId }, { serializers: {
      err: error => this.logError(runId, error),
      stderr: value => typeof value === 'string' ? this.maskers.get(runId)?.text(value) ?? value : value,
    } })
    let entry = this.deps.journal.get(runId) as JournalEntry
    const { assignment } = entry
    if (this.deps.acquireWorkspaceControl) {
      const signal = AbortSignal.any([this.stopController.signal, run.abort.signal])
      run.workspaceControl = await this.deps.acquireWorkspaceControl(assignment, signal, () => {
        this.forceStop(runId, run, 'device_lost')
        run.abort.abort()
      })
      signal.throwIfAborted()
    }
    if ((assignment.policySnapshotRequired || assignment.policySnapshot) && !this.deps.verifyRunPolicy) throw new Error('Run policy verification unavailable')
    // Claim already authorized this exact remote and, where needed, handed
    // over its GitHub credential. Only a new hosted task can read ahead: local
    // credential preparation, old claim helpers and every resume stay serial.
    const readAhead = initialClaim && this.deps.verifyRunPolicy && assignment.remoteUrl && !this.deps.prepareRunGitHub
      && !assignment.continuesRunId && !assignment.resumeSessionId && !assignment.resumeFrom
      && (!assignment.github || Boolean(assignment.github.token))
    const readAbort = readAhead ? new AbortController() : undefined
    const preparationSignal = AbortSignal.any([this.stopController.signal, run.abort.signal, ...(readAbort ? [readAbort.signal] : [])])
    const policyReady = Promise.resolve().then(async () => {
      await this.deps.verifyRunPolicy?.(assignment, preparationSignal)
      preparationSignal.throwIfAborted()
    })
    if (readAbort) {
      let allowEffects!: () => void, refuseEffects!: (reason: unknown) => void
      const entryReady = new Promise<void>((resolve, reject) => { allowEffects = resolve; refuseEffects = reject })
      const authorized = Promise.all([policyReady, entryReady])
      void authorized.catch(() => undefined)
      const done = this.stage(runId, 'repository', observer => this.deps.prepareRepository(assignment, preparationSignal, undefined, authorized, observer), authorized)
      run.repositoryPreparing = { abort: readAbort, done, allowEffects, refuseEffects }
      // Preserve the original rejection for the join without an unhandled
      // rejection while the independent policy transport is still pending.
      void done.catch(() => undefined)
    }
    await policyReady
    verifySkillAssignment(assignment)
    if (assignment.skillReceipt && (this.leaseExpiry(runId)??0)<=Date.now())
      throw new Error('Receipted Skill assignment requires a current server lease')
    if(assignment.skillReceipt?.artifact.registryId==='mikka-team') {
      if(!this.deps.revalidateSkillAssignment)throw new Error('Current team Skill authorization unavailable')
      const current=await this.deps.revalidateSkillAssignment(assignment)
      this.leases.set(runId,Date.parse(verifySkillResume(assignment,current)))
    }
    const adapter = this.adapterFor(runId)
    if (
      assignment.requireSessionResume &&
      entry.questionResumeState === "starting"
    )
      throw new Error(
        "Question continuation delivery is uncertain after interruption; explicit recovery is required",
      )
    if (
      assignment.requireSessionResume &&
      (!assignment.resumeSessionId ||
        !assignment.continuesRunId ||
        !adapter.capabilities.supportsResume ||
        !["claude_code", "codex"].includes(adapter.harness))
    )
      throw new Error(
        "Question continuation requires the original resumable session",
      )

    if (entry.state === "queued") {
      this.setState(runId, "preparing")
      entry = this.deps.journal.get(runId) as JournalEntry
    }
    // Preserve the original entry order, including Skill/session checks and
    // the preparing state, before any repository write or stored stage.
    run.repositoryPreparing?.allowEffects()

    const checkMailbox = () => {
      const lease = this.leaseExpiry(runId)
      const current = this.deps.journal.get(runId)
      assertMailboxRunAuthority({ held: this.active.get(runId) === run, state: current?.state, stopped: this.stopping || run.cancelRequested || run.abort.signal.aborted, lease })
    }
    const prepareGate = async (worktree?: string) => {
      if (run.toolApproval) return run.toolApproval
      const toolApproval = this.deps.prepareRunToolApproval && await daemonTracer.span("daemon.tool_approval", { "mikka.run.id_hash": runIdHash(runId), "mikka.harness": assignment.harness },
        () => this.deps.prepareRunToolApproval!(assignment, preparationSignal, checkMailbox, worktree))
      run.toolApproval = toolApproval
      // Register before an adapter can attach its cancellation callback. Keep
      // a known local lease revocation before SIGTERM/SDK close races an exit.
      toolApproval?.onRevoke(() => {
        if (!this.stopping && this.active.get(runId) === run && !run.forcedStop
          && this.leases.has(runId) && toolApproval.revokeReason === 'device_lost') {
          this.forceStop(runId, run, 'device_lost')
        }
      })
      return toolApproval
    }
    if (assignment.mcp?.mailbox === true && this.deps.prepareRunMailbox) {
      const abort = run.mailboxAbort = new AbortController()
      const signal = AbortSignal.any([preparationSignal, abort.signal])
      // The authorized handshake does not use the checkout. Keep its tools
      // behind the existing join below, while clone/setup runs concurrently.
      run.mailboxPreparing = Promise.resolve()
        .then(() => this.deps.prepareRunMailbox!(assignment, signal, checkMailbox))
        .then(mailbox => { run.mailbox = mailbox; return mailbox })
      // Clone may still be pending when the handshake fails. Its join keeps
      // the original rejection; observe it now without an unhandled rejection.
      void run.mailboxPreparing.catch(() => undefined)
    }
    run.github = await this.deps.prepareRunGitHub?.(assignment, preparationSignal,
      (name, value) => this.addCredential(runId, name, value))
    run.secretBridge = await startTaskSecretBridge({ current: () => assignment.taskSecrets, signal: run.abort.signal })
    const traceContext = daemonTracer.capture()
    // The opening protocol response can precede start() returning its session.
    // Read it again after the running patch. Later observations use the same outbox.
    const recordModel = (sessionId: string, model: string | null | undefined) => {
      const observedModel = model?.trim()
      if (!assignment.acceptsModelObservations || !observedModel || observedModel.length > 500 || !sessionId || run.session?.sessionId !== sessionId ||
        run.sessionEnded || run.observedModel === observedModel) return
      run.observedModel = observedModel
      this.push(runId, { kind: "run", patch: { state: "running", sessionId, observedModel } })
    }
    const baseOptions = {
      traceContext,
      // The owner's own GitHub credential reaches every run that was sent one (decision 2026-11-02-1600).
      github: assignment.github && (assignment.github.token || assignment.mcp || run.github)
        ? { ...assignment.github, runToken: assignment.mcp?.token, issueId: assignment.issueId } : undefined,
      githubEnvironment: run.github?.env,
      onCredential: (name: string, value: string) => this.addCredential(runId, name, value),
      apps: runApps(assignment.mcp),
      mcp: runMcp(assignment.mcp, traceContext),
      runId,
      requireSessionResume: assignment.requireSessionResume,
      kind: assignment.kind,
      factoryCheck: assignment.factoryCheck,
      verifyCommand: assignment.verifyCommand,
      env: taskExecutionEnv(buildChildEnv({
        adapterAllow: adapter.envAllow,
        runId,
      }), { taskEnv: assignment.taskEnv, taskSecretEnv: run.secretBridge?.env }),
      taskEnv: assignment.taskEnv,
      taskSecretEnv: run.secretBridge?.env,
      log,
      networkAllow: repo.networkAllow,
      policy: assignment.policy,
      policyHash: assignment.policySnapshot?.payload.policyHash,
      skills: assignment.skills,
      skillReceipt: assignment.skillReceipt,
      profileSkills: assignment.profileSkills,
      repositorySkills: assignment.repositorySkills,
      onRuntimeModel: (sessionId: string, observedModel: string) => {
        recordModel(sessionId, observedModel)
        if (!assignment.skillReceipt) return
        const current = this.deps.journal.get(runId)
        if (!current?.runtime || isTerminalRunState(current.state) || current.sessionId !== sessionId ||
          current.skillMount?.sessionId !== sessionId || current.skillMount.receiptId !== assignment.skillReceipt?.id) return
        if (current.runtime.observedModel === observedModel && (!current.execution || current.execution.observedModel === observedModel)) return
        this.deps.journal.update(runId, { runtime: { ...current.runtime, observedModel },
          ...(current.execution ? { execution: { ...current.execution, observedModel } } : {}),
        })
      },
      fixture: assignment.fixture,
      model: assignment.model,
      effort: assignment.effort,
      // In memory only: the adapter hands it to the run's CLI environment.
      credential: assignment.modelCredential,
    }
    const prewarm = this.deps.prepareSubscription && ['claude_code', 'codex'].includes(assignment.harness)
      && assignment.subscriptionBinding && assignment.subscriptionLease && !assignment.modelCredential
      && !entry.sessionId && !entry.worktree && !assignment.continuesRunId && !assignment.resumeSessionId
      && !assignment.requireSessionResume && !assignment.resumeFrom
      && (!assignment.github || Boolean(assignment.github.token))
      && (assignment.mcp?.mailbox !== true || assignment.mcp.mailboxCatalogue !== undefined)
    if (prewarm) {
      const abort = run.prewarmAbort = new AbortController()
      const signal = AbortSignal.any([preparationSignal, abort.signal])
      run.sessionPreparing = Promise.resolve().then(async () => {
        const mailbox = await run.mailboxPreparing
        signal.throwIfAborted(); checkMailbox()
        const toolApproval = await prepareGate()
        signal.throwIfAborted(); checkMailbox()
        if (!toolApproval) throw Error('Run tool approval unavailable')
        const guarded = mailbox && { tools: mailbox.tools, close: () => mailbox.close(), request: async (body: unknown, signal?: AbortSignal) => {
          if (!await toolApproval.checkLive()) throw Error('Run tool approval unavailable')
          return mailbox.request(body, signal)
        } }
        return this.deps.prepareSubscription!(assignment, { ...baseOptions, cwd: this.deps.worktrees.pathFor(runId),
          mailbox: guarded, toolApproval, prompt: [assignment.prompt, run.secretBridge?.instructions].filter(Boolean).join('\n\n') }, signal)
      })
      void run.sessionPreparing.catch(() => undefined)
    }
    if (this.stopping || run.cancelRequested) {
      run.repositoryPreparing?.abort.abort()
      await run.repositoryPreparing?.done.catch(() => undefined)
      if (!this.stopping) this.finish(runId, run.forcedStop ?? 'cancelled')
      return
    }
    await (run.repositoryPreparing?.done ?? this.stage(runId, "repository", observer => this.deps.prepareRepository(assignment, preparationSignal, run.github?.env, undefined, observer)))
    if (this.stopping || run.cancelRequested) {
      if (!this.stopping) this.finish(runId, run.forcedStop ?? "cancelled")
      return
    }

    // A retry after a lost lease can arrive while the earlier attempt is
    // still stopping here; let it stop before working on in its worktree.
    const earlier = assignment.continuesRunId
      ? this.active.get(assignment.continuesRunId)
      : undefined
    if (!entry.worktree && earlier) await earlier.done
    if (this.stopping) return

    // A follow-up run continues the earlier run's worktree (ADR 0023);
    // otherwise one per run, reused when resuming after a restart.
    const continued =
      !entry.worktree && assignment.continuesRunId
        ? await this.deps.worktrees.continueFrom(
            repo.path,
            this.deps.journal.get(assignment.continuesRunId)?.worktree ??
              this.deps.worktrees.pathFor(assignment.continuesRunId),
            runId,
          )
        : null
    if (assignment.requireSessionResume && !entry.worktree && !continued)
      throw new Error(
        "Original question worktree is unavailable; a fresh task cannot replace it",
      )
    if (assignment.requireWorktreeContinuation && !entry.worktree && !continued)
      throw new CheckpointRecoveryError('Original worktree is unavailable and there is no usable recovery snapshot.')
    const worktree =
      entry.worktree ??
      continued ??
      (await this.stage(runId, "worktree", async () => this.deps.worktrees.create(
        runId,
        repo.path,
        await this.startPoint(runId, repo, assignment),
      )))
    run.workspaceControl?.setWorktree(worktree)
    if (!entry.worktree) {
      // A continued worktree was bootstrapped by the run that made it.
      // The commit checkpoints diff against: a continued worktree keeps the
      // earlier run's, so its checkpoints still carry everything since.
      const baseCommit =
        (continued && assignment.continuesRunId
          ? this.deps.journal.get(assignment.continuesRunId)?.baseCommit
          : undefined) ?? (await headCommit(repo.path, worktree))
      // Taking over from a machine that went offline: its saved work goes
      // on as uncommitted changes, before setup sees the tree.
      if (!continued && assignment.resumeFrom) {
        const applied = await applyCheckpoint({
          repoPath: repo.path,
          worktree,
          checkpoint: assignment.resumeFrom,
        })
        if (!applied) throw new CheckpointRecoveryError('Checkpoint patch could not be restored. Restore the original worktree before retrying.')
        log.info(
          { files: assignment.resumeFrom.files, applied },
          "checkpoint from the earlier attempt",
        )
      }
      const setup = runPolicy(assignment.policy).readOnly === true ? 'read-only' : continued ? 'continued' : this.deps.bootstrap ? await this.deps.bootstrap(worktree,repo) : await this.deps.worktrees.bootstrap(worktree, repo.path, repo.setup)
      if (!continued && !runPolicy(assignment.policy).readOnly && assignment.projectEnvironment?.setup?.approved) {
        if (runPolicy(assignment.policy).permissions.install_dependency !== 'allow') throw new Error('Environment setup requires dependency-install permission')
        await this.deps.worktrees.bootstrap(worktree, repo.path, assignment.projectEnvironment.setup, assignment.taskEnv)
      }
      log.info({ worktree, setup }, "worktree ready")
      this.deps.journal.update(runId, { worktree, baseCommit })
    }
    if (this.stopping) return

    if (fixedCandidateCheck(assignment)) {
      if (runPolicy(assignment.policy).readOnly !== true)
        throw new Error("Check assignment is missing its read-only policy")
      await fixedCheckSnapshot(repo.path, worktree, assignment.baseBranch)
    }
    const preparedSession = await run.sessionPreparing
    let mailbox = await (run.mailboxPreparing ?? this.deps.prepareRunMailbox?.(assignment, run.abort.signal, checkMailbox))
    run.mailbox = mailbox
    // A STOP/lease transition may win the handshake's final Promise handoff.
    // Own the returned callback before refusing; never start a CLI first.
    if (this.stopping) return
    if (run.cancelRequested) { this.finish(runId, run.forcedStop ?? 'cancelled'); return }
    if (mailbox) checkMailbox()
    const toolApproval = await prepareGate(worktree)
    if (mailbox && toolApproval) {
      const original = mailbox
      mailbox = { tools: original.tools, close: () => original.close(), request: async (body, signal) => {
        if (!await toolApproval.checkLive()) throw new Error('Run tool approval unavailable')
        return original.request(body, signal)
      } }
      run.mailbox = mailbox
    }
    // Cancellation or lease loss may win while the gate is being prepared.
    // Revoke it before refusing, and never launch a CLI with stale authority.
    if (this.stopping) { toolApproval?.revoke(); return }
    if (run.cancelRequested || run.abort.signal.aborted) { toolApproval?.revoke(); this.finish(runId, run.forcedStop ?? 'cancelled'); return }
    if (toolApproval) {
      try { checkMailbox() } catch (error) { toolApproval.revoke(); throw error }
    }
    // Shared Drive folders are on this machine before the agent starts.
    if (!run.drive && this.deps.prepareRunDrive) {
      run.drive = await this.deps.prepareRunDrive(assignment, run.abort.signal).catch(() => undefined)
      await run.drive?.pull()
    }
    const driveBrief = run.drive?.folders.length ? `Shared Drive folders on this machine (synced at checkpoints and when you finish; a version conflict keeps your copy beside the newer one):\n${run.drive.folders.map(folder => `- ${folder.scope}: ${folder.path}${folder.write ? '' : ' (read-only)'}`).join('\n')}` : undefined
    let prompt = [assignment.prompt, run.secretBridge?.instructions, driveBrief].filter(Boolean).join('\n\n')
    let followUp = assignment.followUp
    if (splitChatFiles(prompt).files.length || followUp && splitChatFiles(followUp).files.length) {
      if (!this.deps.downloadChatFile || !this.deps.adapterStateDir) throw Error('Run attachments unavailable')
      const directory = join(this.deps.adapterStateDir, 'inputs', runId)
      const download = (id: string) => this.deps.downloadChatFile!(assignment, id, run.abort.signal)
      prompt = await materializeChatFiles(prompt, directory, download)
      if (followUp) followUp = await materializeChatFiles(followUp, directory, download)
    }
    const options = { ...baseOptions, cwd: worktree, toolApproval, mailbox,
      gitWritePaths: await worktreeGitWritePaths(repo.path, worktree, runId) }

    const resuming =
      entry.sessionId !== null && adapter.capabilities.supportsResume
    // A follow-up run goes on with the earlier run's conversation, sending
    // only what it adds; a run in a fresh worktree starts a new one with
    // the full brief (the old conversation is about files that are gone).
    // After a restart the worktree is already set: it was continued when
    // it is not this run's own.
    const inEarlierWorktree =
      continued !== null ||
      (entry.worktree !== null &&
        resolve(entry.worktree) !== resolve(this.deps.worktrees.pathFor(runId)))
    const continueSession =
      !resuming &&
      assignment.resumeSessionId &&
      assignment.continuesRunId &&
      inEarlierWorktree &&
      adapter.capabilities.supportsResume
        ? {
            sessionId: assignment.resumeSessionId,
            runId: assignment.continuesRunId,
            message: followUp ?? prompt,
          }
        : undefined
    if (assignment.requireSessionResume &&
        (!assignment.resumeSessionId || !assignment.continuesRunId ||
          !adapter.capabilities.supportsResume || (!resuming && !continueSession) ||
          (resuming && entry.sessionId !== assignment.resumeSessionId)))
      throw new Error("factory_question_session_resume_required")
    const benchmark = assignment.benchmark
    const policyDigest = assignment.skillReceipt ? createHash('sha256').update(runPolicyDigestInput(assignment.policy)).digest('hex') : undefined
    if (benchmark && (!assignment.skillReceipt || assignment.harness === "mock" ||
      !assignment.verifyCommand || benchmark.sourceCommit !== this.deps.journal.get(runId)?.baseCommit ||
      policyDigest !== benchmark.policyDigest)) throw new Error("Frozen benchmark execution configuration mismatch")
    let fixtureDigest: string | undefined
    if (benchmark) {
      if (runPolicy(assignment.policy).readOnly !== true) throw new Error("Benchmark fixture must be read-only")
      const fixed = await fixedCheckSnapshot(repo.path, worktree, benchmark.sourceCommit)
      fixtureDigest = createHash('sha256').update(fixed.sha).digest('hex')
      if (fixtureDigest !== benchmark.fixtureDigest) throw new Error("Frozen benchmark fixture digest mismatch")
    }
    const previousMount = entry.skillMount
    const previousExecution = entry.execution
    const previousRuntime = entry.runtime
    let session: AgentSession
    if (assignment.subscriptionBinding && assignment.modelCredential) throw new Error("A run has one model credential")
    try {
      session = await this.stage(runId, "agent_start", async () => preparedSession
      ? await preparedSession.start({ ...options, prompt })
      : assignment.modelCredential && this.deps.startCredential
      ? await this.deps.startCredential(assignment,{...options,prompt})
      : assignment.subscriptionBinding
      ? this.deps.startSubscription
        ? await (async () => {
            if (assignment.requireSessionResume && !resuming)
              this.deps.journal.update(runId, { questionResumeState: "starting" })
            return this.deps.startSubscription!(assignment, { ...options, prompt,
              ...(assignment.requireSessionResume && continueSession ? { continueSession } : {}) })
          })()
        : (()=>{throw new CodedError('subscription_hosted_runtime_unavailable', { detail: 'runner_missing' })})()
      : resuming
      ? await adapter.resume(entry.sessionId as string, options)
      : await (async () => {
          if (assignment.requireSessionResume)
            this.deps.journal.update(runId, {
              questionResumeState: "starting",
            })
          return adapter.start({
            ...options,
            prompt,
            continueSession,
            requireSessionResume: assignment.requireSessionResume,
          })
        })(), undefined, preparedSession)
    } catch (error) {
      if (assignment.skillReceipt) this.deps.journal.update(runId, { skillMount: undefined, execution: undefined, runtime: undefined })
      throw error
    }
    if (assignment.skillReceipt) {
      try {
        const receipt = assignment.skillReceipt
        if (!this.deps.adapterStateDir || assignment.harness === "mock" || !session.sessionId ||
          (resuming && session.sessionId !== entry.sessionId) ||
          (assignment.requireSessionResume && session.sessionId !== assignment.resumeSessionId))
          throw new Error("Skill mount requires the actual original harness session")
        verifySkillAssignment(assignment)
        const file = join(runPaths(this.deps.adapterStateDir, runId).runDir,
          SKILLS_DIR, skillSlug(assignment.skills![0].name), SKILL_BODY_FILE)
        verifyMountedSkill(file, receipt)
        const mount = runSkillMount.parse({ receiptId: receipt.id, versionId: receipt.artifact.versionId,
          sha256: receipt.artifact.sha256, sessionId: session.sessionId, mountedAt: new Date().toISOString() })
        if (previousMount && (previousMount.receiptId !== mount.receiptId || previousMount.versionId !== mount.versionId ||
          previousMount.sha256 !== mount.sha256 || previousMount.sessionId !== mount.sessionId))
          throw new Error("Skill mount receipt or session changed during resume")
        const observedModel = session.runtimeModel ?? (resuming && session.replayedHandoff && previousMount
          ? previousRuntime?.observedModel ?? previousExecution?.observedModel ?? null : null)
        this.deps.journal.update(runId, { skillMount: previousMount ?? mount, sessionId: session.sessionId,
          runtime: runRuntime.parse({ harness: assignment.harness, requestedModel: assignment.model ?? null,
            observedModel, policyDigest, sourceCommit: this.deps.journal.get(runId)?.baseCommit }),
          ...(benchmark ? { execution: runExecution.parse({ ...benchmark, harness: assignment.harness,
            requestedModel: assignment.model ?? null, observedModel,
            policyDigest, fixtureDigest, verifyCommand: assignment.verifyCommand }) } : {}),
        })
      } catch (error) {
        this.deps.journal.update(runId, { skillMount: undefined, execution: undefined, runtime: undefined })
        await session.cancel()
        throw error
      }
    }
    if (assignment.requireSessionResume) {
      if (session.sessionId !== assignment.resumeSessionId) {
        await session.cancel()
        throw new Error(
          "Question continuation returned a different session; execution stopped",
        )
      }
      this.deps.journal.update(runId, {
        questionResumeState: "accepted",
        sessionId: session.sessionId,
      })
    }
    run.session = session
    log.info(
      {
        session_id: session.sessionId,
        resuming,
        continued:
          continueSession !== undefined &&
          session.sessionId === continueSession.sessionId,
      },
      "session open",
    )
    if (entry.state !== "running" || !resuming) {
      this.setState(runId, "running", {
        sessionId: session.sessionId,
        worktree,
      })
    }
    recordModel(session.sessionId, session.runtimeModel)
    if (run.cancelRequested) await this.requestCancel(runId, run)

    const iterator = session.events()[Symbol.asyncIterator]()
    const timedToolChunk = toolDuration()
    const aborted = abortPromise(run.abort.signal)
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), aborted])
        if (this.stopping) return
        const event: AgentEvent =
          next === ABORTED
            ? // The session ignored cancel: detach and end the run here.
              {
                type: "exit",
                outcome: "cancelled",
                error: "Session did not stop after cancel; detached",
              }
            : next.done
              ? {
                  type: "exit",
                  outcome: "failed",
                  error: "Session ended without an exit event",
                }
              : next.value
        if (event.type === 'progress') { run.lastProgressAt = Date.now(); continue }
        if (event.type === "chunk") {
          // Streamed text is not progress; tool calls, steps and files are.
          if (!event.chunk.type.endsWith("-delta"))
            run.lastProgressAt = Date.now()
          if (
            event.chunk.type === "tool-output-available" ||
            event.chunk.type === "tool-output-error"
          ) {
            run.checkpointDue = true
            // A tool call ended, perhaps submit_capture: upload in the background.
            void this.deps.captures?.flush(runId)
          }
          this.emit(runId, timedToolChunk(event.chunk))
          continue
        }
        run.sessionEnded = true
        run.sessionExited = next !== ABORTED && !next.done && event.sessionExited !== false
        clearTimeout(run.cancelTimer)
        if (run.cancelRequested) run.abort.abort()
        const finishingSignal = AbortSignal.any([this.stopController.signal, run.abort.signal])
        run.runtimeTiming?.finishing()
        await this.closeMailbox(run)
        const publication = await verifyAndPublish({
          deps: this.deps,
          runId,
          worktree,
          repo,
          assignment,
          signal: finishingSignal,
          assertLive: () => this.assertFinishingRunLive(runId, finishingSignal),
          githubEnvironment: () => this.active.get(runId)?.github?.env,
          getStopReason: () => stopReasonOf(event, run, assignment),
          isStopping: () => this.stopping,
          cancelRequested: run.cancelRequested,
          logPublishError: (error) => this.deps.log.error({ run_id: runId, err: this.logError(runId, error) }, "publish failed"),
          emitPublish: (data) => this.emit(runId, { type: "data-publish", data }),
        }, event)
        if (!publication) return
        let { report } = publication
        // Captures go up before the run reports its end; a stopping daemon does not wait for them.
        const capturesSaved = !this.stopping && await this.flushCaptures(runId, finishingSignal)
        const stopReason = stopReasonOf(event, run, assignment)
        const checkpoint = await this.saveTerminalCheckpoint(runId, run, capturesSaved)
        if (stopReason === "provider_failure" || stopReason === "quota_exhausted") report = { ...report, providerCheckpoint: checkpoint.checkpoint }
        if (this.stopping) return
        this.finish(runId, stopReason, publication.error, report, event.failureDetails)
        log.info(
          { outcome: event.outcome, stop_reason: stopReason },
          "run ended",
        )
        // A stopped or failed run that changed nothing leaves no worktree or
        // branch behind. A finished chat turn keeps its worktree: the next
        // message continues the session there.
        await this.discardIfEmpty(runId)
        return
      }
    } finally {
      if (this.stopping || run.abort.signal.aborted) {
        // Let go of the session; its CLI keeps it resumable.
        try {
          void iterator.return?.()?.catch(() => undefined)
        } catch {
          // An iterator that cannot be closed early is just dropped.
        }
        void Promise.resolve(session.detach?.()).catch(() => undefined)
      }
    }
  }
}

/** Keeps `open` to the text, reasoning and tool-call ids not yet closed. */
function trackParts(open: Set<string>, chunk: RunChunk) {
  switch (chunk.type) {
    case "text-start":
    case "reasoning-start":
      open.add(`${chunk.type.split("-")[0]}:${chunk.id}`)
      break
    case "text-end":
    case "reasoning-end":
      open.delete(`${chunk.type.split("-")[0]}:${chunk.id}`)
      break
    case "tool-input-start":
    case "tool-input-available":
      open.add(`tool:${chunk.toolCallId}`)
      break
    case "tool-output-available":
    case "tool-output-error":
    case "tool-output-denied":
      open.delete(`tool:${chunk.toolCallId}`)
      break
  }
}

const ABORTED = Symbol("aborted")

function abortPromise(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED)
    else
      signal.addEventListener("abort", () => resolve(ABORTED), { once: true })
  })
}

/**
 * Stop reasons whose worktree stays: the next message continues the session
 * there (a finished chat turn, a question waiting for its answer). Every
 * other ended run, except a verified hand-in, is cleaned up when it left no
 * commit and no change.
 */
const KEEP_WORKTREE: readonly StopReason[] = ["turn_ended", "asked_human", "quota_exhausted", "provider_failure"]

/** Only an adapter's explicit wrapper is trusted, including hosted startup wrappers. */
function startupProviderFailure(error: unknown): ProviderFailure | undefined {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof ProviderFailureError) return providerFailureSchema.parse(error.providerFailure)
  }
  return undefined
}

function stopReasonOf(event: ExitEvent, run: ActiveRun, assignment: RunAssignment): StopReason {
  if (run.forcedStop) return run.forcedStop
  if (event.outcome === "cancelled" || run.cancelRequested) return "cancelled"
  if (event.outcome === "failed" && providerFailureSchema.safeParse(event.providerFailure).success) return "provider_failure"
  if (event.stopReason && event.stopReason !== "provider_failure") return event.stopReason
  // The continuation goes on in this worktree, on a key or after the reset.
  if (event.outcome === "failed" && event.quota && quotaStopApplies(assignment)) return "quota_exhausted"
  return event.outcome === "failed" ? "error" : "turn_ended"
}

/** Mock harness and tests only: no sandbox around the command. */
