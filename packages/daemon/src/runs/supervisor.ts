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
// Liveness: each active run has a server lease (renewed by the device
// heartbeat) and a watchdog on `lastProgressAt`. `check()` stops a run whose
// lease expired (`device_lost`) or that made no progress for `stallMs`
// (`timeout`).
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
// agent. A submission is `succeeded` only when verify passed.
import { fixedCheckSnapshot } from "./check"
import { verifySkillAssignment, verifySkillResume } from '../agents/skill-artifact'
import type { SkillReceiptRevalidation } from '@mikka/protocol/skill'
import { runQuestion } from "@mikka/protocol/run"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import { execa } from "execa"

import {
  emptyRunReport,
  isTerminalRunState,
  runStateForStop,
  type HandoffReport,
  type HeartbeatRun,
  type Harness,
  type RunCheckpoint,
  type RunPublish,
  type RunState,
  type RunSummary,
  type StopReason,
} from "@mikka/protocol"

import {
  applyCheckpoint,
  hasCommit,
  headCommit,
  takeCheckpoint,
} from "../agents/checkpoint"
import type {
  AgentAdapter,
  AgentEvent,
  AgentReport,
  AgentSession,
  ExitEvent,
} from "../adapters/types"
import { runStateChunk, type RunChunk } from "../chunks"
import { buildChildEnv } from "../env"
import {
  HarnessNotSupportedError,
  InvalidIdError,
  RepoNotAllowedError,
  RunNotFoundError,
  type DaemonError,
} from "../errors"
import { isSafeId } from "../ids"
import type { Logger } from "../log"
import type { Outbox } from "../outbox"
import { runPolicy } from "../permissions"
import {
  DEFAULT_LEASE_MS,
  type DeviceRepo,
  type RunAssignment,
} from "../server-link"
import type { WorktreeManager } from "../worktrees"
import type { JournalEntry, RunJournal } from "./journal"

export interface SupervisorDeps {
  journal: RunJournal
  outbox: Outbox
  worktrees: WorktreeManager
  adapters: ReadonlyMap<Harness, AgentAdapter>
  /** The device's current allow-list (`device_repo`). */
  repos: () => DeviceRepo[]
  log: Logger
  revalidateSkillAssignment?:(assignment:RunAssignment)=>Promise<SkillReceiptRevalidation>
  /** Watchdog: no progress for this long stops the run (`timeout`). */
  stallMs?: number
  /** How long `stop()` waits for runs to let go (default 3 s). */
  stopGraceMs?: number
  /** How long a cancelled session may take to exit (default 10 s). */
  cancelGraceMs?: number
  /**
   * Runs a hand-in's verify command. The daemon passes a sandboxed one
   * (`agents/verify.ts`); omitted, the command runs unsandboxed with the
   * clean env, which is only for the mock harness and tests.
   */
  verify?: (run: {
    runId: string
    worktree: string
    repo: DeviceRepo
    command: string
    timeoutMs: number
    signal: AbortSignal
    /** A read-only check: verify may not write the worktree (ADR 0046). */
    readOnly: boolean
  }) => Promise<VerifyResult>
  /**
   * Commits (and, if the repo allows, pushes) a verified hand-in; the
   * result is emitted as a `data-publish` chunk and goes into the
   * completion's `report.publish`. Omitted: nothing is committed.
   */
  publisher?: {
    /** The worktree's content as a tree id, taken before and after verify. */
    snapshot(run: { worktree: string; repo: DeviceRepo }): Promise<string>
    /** Commits `tree`, the content verify passed on. */
    publish(run: {
      runId: string
      worktree: string
      repo: DeviceRepo
      assignment: RunAssignment
      report: HandoffReport
      tree: string
    }): Promise<RunPublish>
  }
}

export interface VerifyResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  output: string
}

export const DEFAULT_STALL_MS = 10 * 60_000
export const DEFAULT_STOP_GRACE_MS = 3_000
export const DEFAULT_CANCEL_GRACE_MS = 10_000
const VERIFY_TIMEOUT_MS = 30 * 60_000
/** `runReport.filesChanged` holds at most this many paths. */
const MAX_REPORTED_FILES = 5_000
/** `runReport.criteria` holds at most this many verdicts (the schema's cap). */
const MAX_REPORTED_CRITERIA = 200
/** The server validates `criterionId` as a uuid; anything else is dropped. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ActiveRun {
  session: AgentSession | null
  cancelRequested: boolean
  /** Set when the watchdog or the lease stopped the run. */
  forcedStop?: StopReason
  lastProgressAt: number
  done: Promise<void>
  /** Aborted by `stop()`, or when a cancelled session does not exit. */
  abort: AbortController
  cancelTimer?: NodeJS.Timeout
  /** The repo checkout the run's worktree belongs to. */
  repoPath: string
  /** A tool call finished since the last checkpoint. */
  checkpointDue?: boolean
  checkpointing?: boolean
  lastCheckpointAt?: number
  /** Tree of the last checkpoint taken; unchanged trees are not sent. */
  lastCheckpointTree?: string
}

/** A run with no tool call in this long still gets a checkpoint when it changed. */
export const CHECKPOINT_EVERY_MS = 2 * 60_000

export class RunSupervisor {
  private active = new Map<string, ActiveRun>()
  /** Lease expiry per run (ms); runs without a server lease are absent. */
  private leases = new Map<string, number>()
  private stopping = false
  /** Runs with an assistant message in progress (`start` sent, no `finish`). */
  private openMessages = new Set<string>()
  /** Per run: text / reasoning ids and tool calls still open in that message. */
  private openParts = new Map<string, Set<string>>()
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
    const lease = this.leases.get(runId)
    const run = this.active.get(runId)
    return {
      ...(lease !== undefined
        ? { leaseExpiresAt: new Date(lease).toISOString() }
        : {}),
      ...(run
        ? { lastProgressAt: new Date(run.lastProgressAt).toISOString() }
        : {}),
    }
  }

  /** Per-run part of the device heartbeat. */
  heartbeatRuns(): HeartbeatRun[] {
    return [...this.active].map(([runId, run]) => ({
      runId,
      lastProgressAt: new Date(run.lastProgressAt).toISOString(),
    }))
  }

  /** Applies leases renewed by the server's heartbeat answer. */
  renewLeases(leases: Record<string, string>) {
    for (const [runId, expiry] of Object.entries(leases)) {
      if (this.active.has(runId)) this.leases.set(runId, Date.parse(expiry))
    }
  }

  /**
   * Stops the runs the server says this device no longer holds. Runs without
   * a server lease (local dev runs) were never the server's to take back.
   */
  revokeLeases(runIds: readonly string[]) {
    for (const runId of runIds) {
      const run = this.active.get(runId)
      if (run && !run.forcedStop && this.leases.has(runId))
        this.forceStop(runId, run, "device_lost")
    }
  }

  /**
   * Saves the work in progress of runs that had a tool call since their last
   * checkpoint, or none for `CHECKPOINT_EVERY_MS`, through `save`. The
   * daemon calls it after each heartbeat; a failed save is tried again on
   * the next one.
   */
  async saveCheckpoints(
    save: (runId: string, checkpoint: RunCheckpoint) => Promise<void>,
    now = Date.now(),
  ) {
    for (const [runId, run] of this.active) {
      const entry = this.deps.journal.get(runId)
      if (!entry?.worktree || !entry.baseCommit || run.checkpointing) continue
      if (run.forcedStop || run.cancelRequested) continue
      const since = run.lastCheckpointAt ?? run.lastProgressAt
      if (!run.checkpointDue && now - since < CHECKPOINT_EVERY_MS) continue
      run.checkpointing = true
      try {
        const taken = await takeCheckpoint({
          repoPath: run.repoPath,
          worktree: entry.worktree,
          baseCommit: entry.baseCommit,
          lastTree: run.lastCheckpointTree,
        })
        if (taken?.checkpoint) await save(runId, taken.checkpoint)
        if (taken) run.lastCheckpointTree = taken.tree
        run.checkpointDue = false
        run.lastCheckpointAt = now
      } catch (error) {
        this.deps.log.warn({ run_id: runId, err: error }, "checkpoint failed")
      } finally {
        run.checkpointing = false
      }
    }
  }

  /** Lease and watchdog pass; the daemon calls it on every tick. */
  check(now = Date.now()) {
    const stallMs = this.deps.stallMs ?? DEFAULT_STALL_MS
    for (const [runId, run] of this.active) {
      if (run.forcedStop) continue
      const lease = this.leases.get(runId)
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
    this.requestCancel(run)
  }

  /** Asks the session to stop; detaches it if it does not within the grace. */
  private requestCancel(run: ActiveRun): Promise<void> {
    run.cancelRequested = true
    if (!run.cancelTimer) {
      run.cancelTimer = setTimeout(
        () => run.abort.abort(),
        this.deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      )
      run.cancelTimer.unref()
    }
    return Promise.resolve(run.session?.cancel()).catch((error: unknown) => {
      this.deps.log.warn({ err: error }, "session cancel failed")
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
      return !e.stopReason || !KEEP_WORKTREE.includes(e.stopReason)
    })
    if (!discardable) return false
    const repo = this.deps
      .repos()
      .find((r) => r.repoId === entry.assignment.repoId)
    if (!repo) return false
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
      this.deps.log.warn({ run_id: logRunId, err }, "could not clean up")
      return false
    }
  }

  activeRunIds(): string[] {
    return [...this.active.keys()]
  }

  /**
   * Starts a claimed run. The allow-list is checked before any worktree or
   * process exists; a refused run is reported failed with the reason.
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
    const repo = this.deps.repos().find((r) => r.repoId === assignment.repoId)
    if (!repo)
      this.refuse(assignment, new RepoNotAllowedError(assignment.repoId))
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
    if (assignment.leaseExpiresAt)
      this.leases.set(assignment.runId, Date.parse(assignment.leaseExpiresAt))
    this.launch(assignment.runId, repo)
    return this.get(assignment.runId)
  }

  /** A claimed run this daemon cannot take: failed, with one completion. */
  private refuse(assignment: RunAssignment, error: DaemonError): never {
    this.deps.outbox.push(assignment.runId, {
      kind: "run",
      patch: { state: "failed", error: error.message, stopReason: "error" },
    })
    this.deps.outbox.push(assignment.runId, {
      kind: "complete",
      completion: { stopReason: "error", report: baseReport(error.message) },
    })
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
        this.deps.journal.update(entry.assignment.runId, {
          lastSeq: outboxSeq,
        })
      const repo = this.deps
        .repos()
        .find((r) => r.repoId === entry.assignment.repoId)
      if (!repo) {
        this.finish(
          entry.assignment.runId,
          "error",
          new RepoNotAllowedError(entry.assignment.repoId).message,
        )
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
          this.leases.set(entry.assignment.runId,Date.parse(verifySkillResume(entry.assignment,current)))
          this.deps.journal.update(entry.assignment.runId,{error:null})
          this.blockedSkillResumes.delete(entry.assignment.runId)
          this.launch(entry.assignment.runId,repo)
        } catch {
          this.leases.delete(entry.assignment.runId)
          this.blockedSkillResumes.add(entry.assignment.runId)
          this.deps.journal.update(entry.assignment.runId,{error:'Skill resume blocked: current online source, authorization and lease required.'})
        }
        continue
      }
      // The old lease is stale; give the first heartbeat time to renew it.
      if (entry.assignment.leaseExpiresAt)
        this.leases.set(entry.assignment.runId, Date.now() + DEFAULT_LEASE_MS)
      this.launch(entry.assignment.runId, repo)
    }
  }

  async send(runId: string, text: string) {
    const run = this.active.get(runId)
    const adapter = this.adapterFor(runId)
    if (!run?.session) throw new RunNotFoundError(runId)
    if (!adapter.capabilities.supportsInterject) {
      throw new Error(
        `Harness "${adapter.harness}" cannot take messages mid-run`,
      )
    }
    // The agent's answer to this goes in a new message, after the person's.
    if (this.openMessages.has(runId)) this.cutMessages.add(runId)
    await run.session.send(text)
  }

  async cancel(runId: string): Promise<RunSummary> {
    const entry = this.deps.journal.get(runId)
    if (!entry) throw new RunNotFoundError(runId)
    const run = this.active.get(runId)
    if (run) {
      await this.requestCancel(run)
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
  private endMessage(runId: string) {
    this.cutMessages.delete(runId)
    this.openParts.get(runId)?.clear()
    if (this.openMessages.delete(runId)) this.append(runId, { type: "finish" })
  }

  /** Outbox first, then the journal: see `resumeAll` for the reconcile. */
  private append(runId: string, chunk: RunChunk) {
    const seq = (this.deps.journal.get(runId)?.lastSeq ?? 0) + 1
    this.deps.outbox.push(runId, { kind: "chunk", seq, chunk })
    this.deps.journal.update(runId, { lastSeq: seq })
  }

  /**
   * The only way into a terminal state: the terminal patch, then exactly one
   * completion for the server, then the outbox is compacted.
   */
  private finish(
    runId: string,
    stopReason: StopReason,
    error?: string,
    report: HandoffReport = baseReport(error),
  ) {
    // The kind the orchestrator dispatched, not what the agent said: an
    // agent must not be able to make a run read as a planning one (ADR ORV-205).
    const planning = this.deps.journal.get(runId)?.assignment.kind === "plan"
    // A planning hand-in leaves its two cards in the conversation (ADR ORV-205).
    this.emitPlanCards(runId, report, planning)
    this.endMessage(runId)
    this.openParts.delete(runId)
    if (stopReason === "submitted") this.setState(runId, "finishing")
    // Only a submission whose verify passed is a success: a failed verify
    // fails the run, an unverified one just stops.
    let state = runStateForStop(stopReason)
    if (stopReason === "submitted" && report.verify.status !== "passed") {
      const failed = report.verify.status === "failed"
      if (!planning) state = failed ? "failed" : "stopped"
      // A `plan` run writes no code, so a verify that did not run says
      // nothing about it.
      if (!failed && !planning)
        error ??= "Submitted, but no verify command ran; the work is unverified"
    }
    if (
      (stopReason === "asked_human" || stopReason === "blocked") &&
      report.question
    ) {
      this.deps.journal.update(runId, {
        waitingQuestionId: report.question.questionId,
      })
    }
    this.setState(runId, state, {
      stopReason,
      ...(error ? { error } : {}),
    })
    this.deps.outbox.push(runId, {
      kind: "complete",
      completion: { stopReason, report },
    })
    this.leases.delete(runId)
    this.deps.outbox.compact(runId).catch((err: unknown) => {
      this.deps.log.error({ run_id: runId, err }, "outbox compaction failed")
    })
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
    this.deps.outbox.push(runId, {
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

  /**
   * The handoff report: the agent's own words (summary, questions, next
   * step, blocker) plus what only the daemon may state: changed files and,
   * after a submit, the verify result. Anything else the agent sent
   * (a self-reported verify, say) is dropped. `verifyError` describes a
   * failed verify (command and exit code) for the run's error text.
   */
  private async report(
    runId: string,
    worktree: string,
    repo: DeviceRepo,
    assignment: RunAssignment,
    stopReason: StopReason,
    error: string | undefined,
    agent: AgentReport | undefined,
  ): Promise<{ report: HandoffReport; verifyError?: string; tree?: string }> {
    let report: HandoffReport = {
      ...baseReport(error),
      ...pickAgentReport(agent),
    }
    const filesChanged = (
      await this.deps.worktrees.changedFiles(worktree).catch(() => [])
    ).slice(0, MAX_REPORTED_FILES)
    const command = assignment.verifyCommand
    // A `plan` run writes no code: there is nothing for the issue's verify
    // command to check (ADR ORV-205).
    if (stopReason !== "submitted" || !command || assignment.kind === "plan")
      return {
        report: { ...report, filesChanged, verify: { status: "not_run" } },
      }
    let execution: Partial<HandoffReport["verify"]> = {}
    const failed = (output: string, verifyError: string) => ({
      report: {
        ...report,
        filesChanged,
        verify: { status: "failed" as const, command, output, ...execution },
      },
      verifyError,
    })
    // The agent is gone; verify runs code it wrote. What gets committed is
    // the content verify started on, and only if verify left it unchanged.
    const publisher = this.deps.publisher
    let before: string | undefined
    try {
      if (fixedCandidateCheck(assignment)) {
        if (runPolicy(assignment.policy).readOnly !== true)
          throw new Error("Check assignment is missing its read-only policy")
        const fixed = await fixedCheckSnapshot(
          repo.path,
          worktree,
          assignment.baseBranch,
        )
        report = { ...report, check: { sha: fixed.sha, readOnly: true } }
        before = fixed.tree
      } else {
        before = await publisher?.snapshot({ worktree, repo })
      }
    } catch (snapshotError) {
      return failed("", `Could not read the worktree: ${String(snapshotError)}`)
    }
    const result = await (this.deps.verify ?? unsandboxedVerify)({
      runId,
      worktree,
      repo,
      command,
      timeoutMs: VERIFY_TIMEOUT_MS,
      signal: this.stopController.signal,
      readOnly: runPolicy(assignment.policy).readOnly === true,
    })
    execution = {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
    }
    const output = result.output.slice(-4000)
    if (result.exitCode !== 0 || result.timedOut)
      return failed(output, verifyFailure(command, result))
    const after = fixedCandidateCheck(assignment)
      ? await fixedCheckSnapshot(repo.path, worktree, assignment.baseBranch)
          .then((fixed) => fixed.tree)
          .catch(() => null)
      : publisher
        ? await publisher.snapshot({ worktree, repo }).catch(() => null)
        : undefined
    if (after !== before)
      return failed(
        output,
        `Submitted, but the verify command changed the worktree (\`${command}\`); the work is unverified`,
      )
    return {
      report: {
        ...report,
        filesChanged,
        verify: { status: "passed", command, output, ...execution },
      },
      tree: before,
    }
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
    // Taking over a run from another machine: start where it started.
    const resume = assignment.resumeFrom?.baseCommit
    if (resume && (await hasCommit(repo.path, resume))) return resume
    const branch = assignment.pushBranch
    if (!branch || repo.push?.approved !== true) return assignment.baseBranch
    try {
      return await this.deps.worktrees.fetchBranch(
        repo.path,
        repo.push.remote ?? "origin",
        branch,
        runId,
      )
    } catch (error) {
      this.deps.log.info(
        { run_id: runId, branch, err: error },
        "issue branch not fetched; starting from the base branch",
      )
      return assignment.baseBranch
    }
  }

  /**
   * A failed commit or push is reported (in a `data-publish` chunk and in
   * the completion's report), never fails the verified run.
   */
  private async publish(
    runId: string,
    worktree: string,
    repo: DeviceRepo,
    assignment: RunAssignment,
    report: HandoffReport,
    tree: string,
  ): Promise<RunPublish> {
    const publisher = this.deps.publisher as NonNullable<
      SupervisorDeps["publisher"]
    >
    let data: RunPublish
    try {
      data = await publisher.publish({
        runId,
        worktree,
        repo,
        assignment,
        report,
        tree,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log.error({ run_id: runId, err: error }, "publish failed")
      data = {
        branch: "",
        commit: null,
        pushed: false,
        remote: null,
        note: `Commit failed: ${message}`.slice(0, 2_000),
      }
    }
    this.emit(runId, { type: "data-publish", data })
    return data
  }

  private launch(runId: string, repo: DeviceRepo) {
    const run: ActiveRun = {
      repoPath: repo.path,
      session: null,
      cancelRequested: false,
      lastProgressAt: Date.now(),
      done: Promise.resolve(),
      abort: new AbortController(),
    }
    run.done = this.drive(runId, repo, run)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.log.error({ run_id: runId, err: error }, "run failed")
        if (this.stopping) return
        try {
          this.finish(runId, "error", message)
        } catch (finishError) {
          this.deps.log.error(
            { run_id: runId, err: finishError },
            "could not record the run's end",
          )
        }
      })
      .finally(() => {
        clearTimeout(run.cancelTimer)
        this.active.delete(runId)
      })
    this.active.set(runId, run)
  }

  private async drive(runId: string, repo: DeviceRepo, run: ActiveRun) {
    const log = this.deps.log.child({ run_id: runId })
    let entry = this.deps.journal.get(runId) as JournalEntry
    const { assignment } = entry
    verifySkillAssignment(assignment)
    if (assignment.skillReceipt && (this.leases.get(runId)??0)<=Date.now())
      throw new Error('Receipted Skill assignment requires a current server lease')
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
    const worktree =
      entry.worktree ??
      continued ??
      (await this.deps.worktrees.create(
        runId,
        repo.path,
        await this.startPoint(runId, repo, assignment),
      ))
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
        log.info(
          { files: assignment.resumeFrom.files, applied },
          "checkpoint from the earlier attempt",
        )
      }
      const setup =
        runPolicy(assignment.policy).readOnly === true
          ? "read-only"
          : continued
            ? "continued"
            : await this.deps.worktrees.bootstrap(
                worktree,
                repo.path,
                repo.setup,
              )
      log.info({ worktree, setup }, "worktree ready")
      this.deps.journal.update(runId, { worktree, baseCommit })
    }
    if (this.stopping) return

    if (fixedCandidateCheck(assignment)) {
      if (runPolicy(assignment.policy).readOnly !== true)
        throw new Error("Check assignment is missing its read-only policy")
      await fixedCheckSnapshot(repo.path, worktree, assignment.baseBranch)
    }
    const options = {
      runId,
      requireSessionResume: assignment.requireSessionResume,
      kind: assignment.kind,
      cwd: worktree,
      env: buildChildEnv({
        adapterAllow: adapter.envAllow,
        runId,
      }),
      log,
      networkAllow: repo.networkAllow,
      policy: assignment.policy,
      skills: assignment.skills,
      skillReceipt: assignment.skillReceipt,
      fixture: assignment.fixture,
      model: assignment.model,
    }
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
            message: assignment.followUp ?? assignment.prompt,
          }
        : undefined
    const session = resuming
      ? await adapter.resume(entry.sessionId as string, options)
      : await (async () => {
          if (assignment.requireSessionResume)
            this.deps.journal.update(runId, {
              questionResumeState: "starting",
            })
          return adapter.start({
            ...options,
            prompt: assignment.prompt,
            continueSession,
            requireSessionResume: assignment.requireSessionResume,
          })
        })()
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
    if (run.cancelRequested) await this.requestCancel(run)

    const iterator = session.events()[Symbol.asyncIterator]()
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
        if (event.type === "chunk") {
          // Streamed text is not progress; tool calls, steps and files are.
          if (!event.chunk.type.endsWith("-delta"))
            run.lastProgressAt = Date.now()
          if (
            event.chunk.type === "tool-output-available" ||
            event.chunk.type === "tool-output-error"
          )
            run.checkpointDue = true
          this.emit(runId, event.chunk)
          continue
        }
        const stopReason = stopReasonOf(event, run)
        const error =
          event.error ??
          (stopReason === "turn_ended"
            ? "Session ended without a submission"
            : stopReason === "timeout"
              ? "No progress before the watchdog limit"
              : stopReason === "device_lost"
                ? "Run lease expired; the server could not be reached"
                : undefined)
        const outcome = await this.report(
          runId,
          worktree,
          repo,
          assignment,
          stopReason,
          error,
          event.report,
        )
        if (this.stopping) return
        const { verifyError, tree } = outcome
        let report = outcome.report
        if (
          stopReason === "submitted" &&
          report.verify.status === "passed" &&
          tree &&
          // A read-only check (ADR 0046) never commits or pushes: it reports
          // on the commit the implementation run already pushed.
          runPolicy(assignment.policy).readOnly !== true
        ) {
          const publish = await this.publish(
            runId,
            worktree,
            repo,
            assignment,
            report,
            tree,
          )
          report = { ...report, publish }
        }
        this.finish(runId, stopReason, error ?? verifyError, report)
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
 * The only parts of a handoff report the agent may fill, cut to the
 * protocol's limits (`runReport`) so the server never refuses a report for
 * its length.
 */
function pickAgentReport(agent: AgentReport | undefined): AgentReport {
  if (!agent) return {}
  const picked: AgentReport = {}
  if (typeof agent.summary === "string")
    picked.summary = agent.summary.slice(0, 10_000)
  if (
    Array.isArray(agent.openQuestions) &&
    agent.openQuestions.every((q) => typeof q === "string")
  )
    picked.openQuestions = agent.openQuestions
      .slice(0, 50)
      .map((q) => q.slice(0, 2_000))
  if (typeof agent.nextStep === "string")
    picked.nextStep = agent.nextStep.slice(0, 2_000)
  else if (agent.nextStep === null) picked.nextStep = null
  if (typeof agent.blockedOn === "string")
    picked.blockedOn = agent.blockedOn.slice(0, 500)
  const question = runQuestion.safeParse(agent.question)
  if (question.success) picked.question = question.data
  // The planning hand-in was already parsed and checked by the adapter's
  // `readHandoff`; it is copied whole or not at all (ADR ORV-205).
  if (agent.plan) picked.plan = agent.plan
  // The check's per-criterion verdicts (ADR 0046). Kept only when the entry
  // is well formed and names a criterion by uuid: the run-complete route
  // validates the report, and one bad entry would throw the whole hand-in
  // away. An entry that survives with no evidence still counts as not
  // passed — the orchestrator decides that, not the agent.
  if (Array.isArray(agent.criteria)) {
    const criteria: NonNullable<HandoffReport["criteria"]> = []
    for (const entry of agent.criteria) {
      if (criteria.length >= MAX_REPORTED_CRITERIA) break
      if (!entry || typeof entry !== "object") continue
      const { criterionId, passed, evidence } = entry as {
        criterionId?: unknown
        passed?: unknown
        evidence?: unknown
      }
      if (typeof criterionId !== "string" || !UUID_RE.test(criterionId))
        continue
      if (typeof passed !== "boolean") continue
      criteria.push({
        criterionId,
        passed,
        ...(typeof evidence === "string"
          ? { evidence: evidence.slice(0, 10_000) }
          : {}),
      })
    }
    picked.criteria = criteria
  }
  return picked
}

/**
 * Stop reasons whose worktree stays: the next message continues the session
 * there (a finished chat turn, a question waiting for its answer). Every
 * other ended run, except a verified hand-in, is cleaned up when it left no
 * commit and no change.
 */
const KEEP_WORKTREE: readonly StopReason[] = ["turn_ended", "asked_human"]

function stopReasonOf(event: ExitEvent, run: ActiveRun): StopReason {
  if (run.forcedStop) return run.forcedStop
  if (event.outcome === "cancelled" || run.cancelRequested) return "cancelled"
  if (event.stopReason) return event.stopReason
  return event.outcome === "failed" ? "error" : "turn_ended"
}

/** Mock harness and tests only: no sandbox around the command. */
async function unsandboxedVerify(run: {
  worktree: string
  command: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<VerifyResult> {
  const result = await execa(run.command, {
    shell: true,
    cwd: run.worktree,
    env: buildChildEnv(),
    extendEnv: false,
    reject: false,
    all: true,
    stdin: "ignore",
    timeout: run.timeoutMs,
    cancelSignal: run.signal,
  })
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut,
    output: String(result.all ?? ""),
  }
}

function verifyFailure(
  command: string,
  result: Pick<VerifyResult, "exitCode" | "signal" | "timedOut">,
): string {
  const how = result.timedOut
    ? "timed out"
    : result.exitCode !== null
      ? `exited with code ${result.exitCode}`
      : result.signal
        ? `was killed by ${result.signal}`
        : "did not finish"
  return `Submitted, but the verify command failed: \`${command}\` ${how}`
}

export function baseReport(summary = ""): HandoffReport {
  return emptyRunReport(summary.slice(0, 10_000))
}

/** Existing acceptance runs remain compatible; Factory checks are exact-SHA read-only runs. */
function fixedCandidateCheck(assignment: RunAssignment) {
  return (
    assignment.kind === "acceptance" &&
    runPolicy(assignment.policy).readOnly === true &&
    /^[a-f0-9]{40}$/.test(assignment.baseBranch)
  )
}
