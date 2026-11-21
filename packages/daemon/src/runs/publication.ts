import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { emptyRunReport, runStateForStop, type HandoffReport, type RunCompletion, type RunPublish, type RunState, type StopReason } from "@mikka/protocol"
import { providerFailureSchema } from "@mikka/protocol/provider-failure"
import { runCriterion, reviewVerdict, runVisualEvidence, runQuestion, type RunSkillPrompt } from "@mikka/protocol/run"
import { captureRunFailure, type RunFailure } from "@mikka/protocol/run-failure"
import { profileSkillLoadReceiptSchema, PROFILE_SKILLS_DIR, PROFILE_SKILL_LOADS_DIR, skillPromptPlan, type ProfileSkillLoadReceipt, type ProfileSkillRef, type ProfileSkillRunReport } from "@mikka/protocol/skill"
import { execa } from "execa"
import type { AgentReport, AgentSession, ExitEvent } from "../adapters/types"
import { retainDeliverable } from "../agents/publish"
import { runPaths } from "../agents/run-context"
import type { VerifyResult } from "../agents/verify"
import { buildChildEnv } from "../env"
import { DAEMON_VERSION } from "../paths"
import { pushDecision, runPolicy } from "../permissions"
import type { DeviceRepo, RunAssignment } from "../server-link"
import type { SpanHandle } from "../tracing"
import type { WorktreeManager } from "../worktrees"
import { fixedCheckSnapshot } from "./check"
import type { RunJournal } from "./journal"

export interface PublicationDeps {
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
    githubEnvironment?: Record<string, string>
  }) => Promise<VerifyResult>
  /**
   * Commits (and, if the repo allows, pushes) a verified hand-in; the
   * result is emitted as a `data-publish` chunk and goes into the
   * completion's `report.publish`. Omitted: nothing is committed.
   */
  publisher?: {
    /** The worktree's content as a tree id, taken before and after verify. */
    snapshot(run: { worktree: string; repo: DeviceRepo; signal?: AbortSignal }): Promise<string>
    /** Commits `tree`, the content verify passed on. */
    publish(run: {
      runId: string
      worktree: string
      repo: DeviceRepo
      assignment: RunAssignment
      report: HandoffReport
      tree: string
      githubEnvironment?: Record<string, string>
      signal: AbortSignal
    }): Promise<RunPublish>
  }
}

interface PublicationContext {
  deps: PublicationDeps & {
    journal: Pick<RunJournal, "get" | "update">
    worktrees: Pick<WorktreeManager, "changedFiles">
    adapterStateDir?: string
  }
  runId: string
  worktree: string
  repo: DeviceRepo
  assignment: RunAssignment
  signal: AbortSignal
  assertLive(): void
  githubEnvironment(): Record<string, string> | undefined
  getStopReason(): StopReason
  isStopping(): boolean
  cancelRequested: boolean
  logPublishError(error: unknown): void
  emitPublish(data: RunPublish): void
}

interface FinishContext {
  runId: string
  journal: Pick<RunJournal, "get" | "update">
  active?: {
    cancelRequested: boolean
    forcedStop?: StopReason
    span?: SpanHandle
    safePoint?: HandoffReport["safePoint"]
    session: Pick<AgentSession, "runtimeModel"> | null
  }
  closeOutput(report: HandoffReport, planning: boolean): void
  setState(state: RunState, extra?: { error?: string; stopReason?: StopReason }): void
  complete(completion: RunCompletion): void
}

const VERIFY_TIMEOUT_MS = 30 * 60_000
/** `runReport.filesChanged` holds at most this many paths. */
const MAX_REPORTED_FILES = 5_000
/** `runReport.criteria` holds at most this many verdicts (the schema's cap). */
const MAX_REPORTED_CRITERIA = 200
/** The server validates `criterionId` as a uuid; anything else is dropped. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function verifyAndPublish(context: PublicationContext, event: ExitEvent) {
  const { assignment, repo, worktree, signal } = context
  const initialStopReason = context.getStopReason()
  const error =
    event.error ??
    (initialStopReason === "turn_ended"
      ? "Session ended without a submission"
      : initialStopReason === "timeout"
        ? "No progress before the watchdog limit"
        : initialStopReason === "device_lost"
          ? "Run lease expired; the server could not be reached"
          : undefined)
  let outcome: Awaited<ReturnType<typeof collectReport>>
  try {
    if (assignment.benchmark && !context.cancelRequested) {
      const fixed = await fixedCheckSnapshot(repo.path, worktree, assignment.benchmark.sourceCommit, signal)
      if (createHash('sha256').update(fixed.sha).digest('hex') !== assignment.benchmark.fixtureDigest)
        throw new Error("Benchmark fixture changed during model execution")
    }
    outcome = await collectReport(context, initialStopReason, error, event.report)
  } catch (error) {
    if (!signal.aborted) throw error
    outcome = { report: { ...baseReport(), ...pickAgentReport(event.report) } }
  }
  if (context.isStopping()) return
  const stopReason = context.getStopReason()
  const { verifyError, tree } = outcome
  let report = stopReason === "quota_exhausted"
    ? { ...outcome.report, resetsAt: event.quota?.resetsAt ?? null }
    : outcome.report
  if (stopReason === "provider_failure") {
    report = { ...report, providerFailure: providerFailureSchema.parse(event.providerFailure),
      ...(event.quota ? { resetsAt: event.quota.resetsAt } : {}) }
  }
  const policy = runPolicy(assignment.policy)
  const { publisher } = context.deps
  if (
    stopReason === "submitted" &&
    report.verify.status !== "failed" &&
    tree &&
    publisher &&
    // The draft-PR exception requires an explicit repository push
    // approval. It must not even create a local commit without it.
    (report.verify.status === "passed" || pushDecision(policy).push) &&
    // A read-only check (ADR 0046) never commits or pushes: it reports
    // on the commit the implementation run already pushed.
    policy.readOnly !== true
  ) {
    const publish = await publishRun(context, publisher, report, tree)
    report = { ...report, publish }
  }
  return { report, error: error ?? verifyError }
}

export function finishRun(
  context: FinishContext,
  stopReason: StopReason,
  error?: string,
  report: HandoffReport = baseReport(error),
  failureDetails?: RunFailure,
) {
  const { runId, journal, active } = context
  // Report collection and capture uploads can await after the provider's
  // terminal event. A stop received in that interval still owns completion.
  if (active?.cancelRequested || active?.forcedStop) {
    stopReason = active.forcedStop ?? "cancelled"
    error = undefined
  }
  active?.span?.set("mikka.outcome", stopReason)
  if (stopReason !== "provider_failure" && report.providerFailure) {
    const { providerFailure: _failure, ...rest } = report
    report = rest
  }
  if (stopReason !== "provider_failure" && stopReason !== "quota_exhausted" && report.providerCheckpoint) {
    const { providerCheckpoint: _checkpoint, ...rest } = report
    report = rest
  }
  // The kind the orchestrator dispatched, not what the agent said: an
  // agent must not be able to make a run read as a planning one (ADR ORV-205).
  const entry = journal.get(runId)
  const planning = entry?.assignment.kind === "plan"
  // A repository handoff, like a blocked question, keeps the original
  // checkout for continuation/history; explicit cancellation can discard it.
  if (entry && stopReason === "blocked" && report.repositorySelection)
    entry.assignment.preserveQuestionWorktree = true
  const readOnlyTask = entry && (isReadOnlyTask(entry.assignment) || entry.assignment.factoryCheck?.reportOnly === true || entry.assignment.factoryExecuteKind === 'deliverable')
  // Never copy trusted evidence from an adapter/model report.
  const { sourceCommit: _source, deliverableCommit: _delivery, skillMount: _mount, skillPrompt: _prompt, execution: _execution, runtime: _runtime, safePoint: _safePoint, ...content } = report
  report = {
    ...content,
    ...(active?.safePoint ? { safePoint: active.safePoint } : {}),
    ...(entry?.baseCommit && /^[a-f0-9]{40}$/.test(entry.baseCommit)
      ? { sourceCommit: entry.baseCommit } : {}),
    ...(entry?.assignment.factoryExecuteKind === 'deliverable' && entry.deliverableCommit ? { deliverableCommit: entry.deliverableCommit } : {}),
    // What the prompt actually carried of the run's skills; a deferred body
    // is a fact the person needs to see, not something to leave unsaid.
    ...(entry && skillPromptOf(entry.assignment) ? { skillPrompt: skillPromptOf(entry.assignment) } : {}),
    ...(entry?.skillMount && entry.skillMount.sessionId === entry.sessionId &&
      entry.skillMount.receiptId === entry.assignment.skillReceipt?.id &&
      entry.skillMount.versionId === entry.assignment.skillReceipt?.artifact.versionId &&
      entry.skillMount.sha256 === entry.assignment.skillReceipt?.artifact.sha256
      ? { skillMount: entry.skillMount,
        ...(entry.runtime ? { runtime: { ...entry.runtime,
          observedModel: active?.session?.runtimeModel ?? entry.runtime.observedModel,
        } } : {}),
        ...(entry.execution && entry.assignment.benchmark ? { execution: {
          ...entry.execution,
          observedModel: active?.session?.runtimeModel ?? entry.execution.observedModel,
        } } : {}),
      } : {}),
  }
  // A planning hand-in leaves its two cards in the conversation (ADR ORV-205).
  context.closeOutput(report, planning)
  if (stopReason === "submitted") context.setState("finishing")
  // A trusted daemon push can hand unverified work in for a draft PR.
  // Without that approved publication, the existing unverified stop stays.
  let state = runStateForStop(stopReason)
  if (stopReason === "submitted" && report.verify.status !== "passed") {
    const failed = report.verify.status === "failed"
    if (!planning && !readOnlyTask) state = failed ? "failed" : report.publish?.pushed === true ? "succeeded" : "stopped"
    // A `plan` run writes no code, so a verify that did not run says
    // nothing about it.
    if (!failed && !planning && !readOnlyTask)
      error ??= "Submitted, but no verify command ran; the work is unverified"
  }
  if (
    (stopReason === "asked_human" || stopReason === "blocked") &&
    report.question
  ) {
    journal.update(runId, {
      waitingQuestionId: report.question.questionId,
    })
  }
  // A provider's terminal failure is an ordinary iterator result, not a
  // throw. Mark its run span explicitly without passing private CLI text.
  if (state === 'failed') active?.span?.fail({ name: 'RunFailure' }, stopReason)
  else active?.span?.set('mikka.outcome', stopReason)
  context.setState(state, {
    stopReason,
    ...(error ? { error } : {}),
  })
  const terminalFailure = state === "failed" && !active?.cancelRequested && !active?.forcedStop
    ? captureRunFailure(failureDetails ?? new Error(error ?? report.summary), {
      runId, appVersion: DAEMON_VERSION, sensitiveText: [entry?.assignment.prompt ?? ""],
    }) : undefined
  context.complete({ stopReason, report, ...(terminalFailure ? { failureDetails: terminalFailure } : {}) })
}

/**
 * The handoff report: the agent's own words (summary, questions, next
 * step, blocker) plus what only the daemon may state: changed files and,
 * after a submit, the verify result. Anything else the agent sent
 * (a self-reported verify, say) is dropped. `verifyError` describes a
 * failed verify (command and exit code) for the run's error text.
 */
async function collectReport(
  context: PublicationContext,
  stopReason: StopReason,
  error: string | undefined,
  agent: AgentReport | undefined,
): Promise<{ report: HandoffReport; verifyError?: string; tree?: string }> {
  const { deps, runId, worktree, repo, assignment, signal } = context
  const profileSkills = profileSkillReport(runId, assignment, deps.adapterStateDir)
  let report: HandoffReport = {
    ...baseReport(error),
    ...pickAgentReport(agent),
    ...(profileSkills ? { profileSkills } : {}),
  }
  const filesChanged = (
    await deps.worktrees.changedFiles(worktree, deps.journal.get(runId)?.baseCommit).catch(() => [])
  ).slice(0, MAX_REPORTED_FILES)
  const inferred = assignment.factoryCheck?.stage === 'verify' && assignment.factoryCheck.inferCommand && !assignment.factoryCheck.reportOnly ? report.verificationCommand : undefined
  const command = assignment.verifyCommand ?? inferred?.command
  if (stopReason === 'submitted') context.assertLive()
  if (stopReason === 'submitted' && assignment.factoryExecuteKind === 'deliverable') {
    const deliverableCommit = await retainDeliverable(repo.path, worktree, runId, signal)
    context.assertLive()
    deps.journal.update(runId, { deliverableCommit })
  }
  // An unsubmitted fixed check still records what the daemon actually found.
  // A dirty or unavailable worktree grants no snapshot provenance. Neither
  // outcome turns this stopped run into a verdict or executes verification.
  if (stopReason !== 'submitted' && fixedCandidateCheck(assignment)) {
    const fixed = await fixedCheckSnapshot(repo.path, worktree, assignment.baseBranch, signal).catch(() => null)
    if (fixed) report = { ...report, check: { sha: fixed.sha, readOnly: true } }
  }
  // A `plan` run writes no code: there is nothing for the issue's verify
  // command to check (ADR ORV-205).
  if (stopReason !== "submitted" || assignment.kind === "plan" || isReadOnlyTask(assignment) || assignment.factoryExecuteKind === 'deliverable')
    return {
      report: { ...report, filesChanged, verify: { status: "not_run" } },
    }
  if (!command) {
    if (fixedCandidateCheck(assignment)) {
      const fixed = await fixedCheckSnapshot(repo.path, worktree, assignment.baseBranch, signal)
      report = { ...report, check: { sha: fixed.sha, readOnly: true } }
    }
    // No command was approved for this repository. Snapshot the submitted
    // tree for an explicitly approved push, while retaining not_run.
    context.assertLive()
    const tree = await deps.publisher?.snapshot({ worktree, repo, signal })
    context.assertLive()
    return { report: { ...report, filesChanged, verify: { status: "not_run" } }, tree }
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
  const publisher = deps.publisher
  let before: string | undefined
  try {
    if (fixedCandidateCheck(assignment)) {
      if (runPolicy(assignment.policy).readOnly !== true)
        throw new Error("Check assignment is missing its read-only policy")
      const fixed = await fixedCheckSnapshot(
        repo.path,
        worktree,
        assignment.baseBranch,
        signal,
      )
      report = { ...report, check: { sha: fixed.sha, readOnly: true } }
      before = fixed.tree
    } else {
      before = await publisher?.snapshot({ worktree, repo, signal })
    }
  } catch (snapshotError) {
    signal.throwIfAborted()
    return failed("", `Could not read the worktree: ${String(snapshotError)}`)
  }
  context.assertLive()
  const result = await (deps.verify ?? unsandboxedVerify)({
    runId,
    worktree,
    repo,
    command,
    timeoutMs: VERIFY_TIMEOUT_MS,
    signal,
    readOnly: runPolicy(assignment.policy).readOnly === true,
    githubEnvironment: context.githubEnvironment(),
  })
  context.assertLive()
  execution = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  }
  const output = result.output.slice(-4000)
  if (result.exitCode !== 0 || result.timedOut)
    return failed(output, verifyFailure(command, result))
  const after = fixedCandidateCheck(assignment)
    ? await fixedCheckSnapshot(repo.path, worktree, assignment.baseBranch, signal)
        .then((fixed) => fixed.tree)
        .catch(() => null)
    : publisher
      ? await publisher.snapshot({ worktree, repo, signal }).catch(() => null)
      : undefined
  context.assertLive()
  if (after !== before)
    return failed(
      output,
      `Submitted, but the verify command changed the worktree (\`${command}\`); the work is unverified`,
    )
  return {
    report: {
      ...report,
      filesChanged,
      verify: { status: "passed", command, output, ...(inferred ? { inferredFrom: inferred.basis } : {}), ...execution },
    },
    tree: before,
  }
}

/**
 * A failed commit or push is reported (in a `data-publish` chunk and in
 * the completion's report), never fails the verified run.
 */
async function publishRun(
  context: PublicationContext,
  publisher: NonNullable<PublicationDeps["publisher"]>,
  report: HandoffReport,
  tree: string,
): Promise<RunPublish> {
  const { runId, worktree, repo, assignment, signal } = context
  let data: RunPublish
  try {
    context.assertLive()
    data = await publisher.publish({
      runId,
      worktree,
      repo,
      assignment,
      report,
      tree,
      githubEnvironment: context.githubEnvironment(),
      signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!signal.aborted) context.logPublishError(error)
    data = {
      branch: "",
      commit: null,
      pushed: false,
      remote: null,
      note: signal.aborted ? "Run stopped before publication completed" : `Commit failed: ${message}`.slice(0, 2_000),
    }
  }
  context.emitPublish(data)
  return data
}

/**
 * What the frozen Profile selected and what its agent actually loaded. The
 * load receipts are written by the `load_skill` tool itself; a configured
 * Skill without a receipt is not reported as used. Digests must match the
 * configured pinned body, so a tampered manifest cannot mint a receipt.
 */
function profileSkillReport(runId: string, assignment: RunAssignment, adapterStateDir?: string): ProfileSkillRunReport | undefined {
  const configured: ProfileSkillRef[] = (assignment.profileSkills ?? []).map(skill => ({ id: skill.id, name: skill.name, source: skill.source, digest: skill.digest }))
  for (const slug of assignment.repositorySkills ?? []) {
    if (!configured.some(ref => ref.id === `repository:${slug}`)) configured.push({ id: `repository:${slug}`, name: slug, source: 'repository', digest: null })
  }
  if (configured.length === 0) return undefined
  const loaded: ProfileSkillLoadReceipt[] = []
  if (adapterStateDir) {
    const dir = join(runPaths(adapterStateDir, runId).runDir, PROFILE_SKILLS_DIR, PROFILE_SKILL_LOADS_DIR)
    try {
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.json') || loaded.length >= configured.length) continue
        const file = join(dir, name), meta = lstatSync(file, { throwIfNoEntry: false })
        if (!meta?.isFile() || meta.isSymbolicLink() || meta.nlink !== 1 || meta.size < 2 || meta.size > 4096) continue
        const receipt = profileSkillLoadReceiptSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
        if (!receipt.success || loaded.some(item => item.id === receipt.data.id)) continue
        // A declared repository Skill has no server-side digest; its receipt
        // carries the digest the tool checked against the pinned body.
        if (!configured.some(ref => ref.id === receipt.data.id && (ref.digest === null || ref.digest === receipt.data.digest))) continue
        loaded.push(receipt.data)
      }
    } catch { /* No loads yet, or an unreadable receipt: nothing is claimed as used. */ }
  }
  return { configured, loaded }
}

/**
 * The only parts of a handoff report the agent may fill, cut to the
 * protocol's limits (`runReport`) so the server never refuses a report for
 * its length.
 */
function pickAgentReport(agent: AgentReport | undefined): AgentReport {
  if (!agent) return {}
  const picked: AgentReport = {}
  if (agent.repositorySelection) picked.repositorySelection = agent.repositorySelection
  if (agent.verificationCommand && typeof agent.verificationCommand.command === 'string' && agent.verificationCommand.command.trim() && typeof agent.verificationCommand.basis === 'string' && agent.verificationCommand.basis.trim())
    picked.verificationCommand = { command: agent.verificationCommand.command.trim().slice(0, 2000), basis: agent.verificationCommand.basis.trim().slice(0, 2000) }
  const visualEvidence = runVisualEvidence.safeParse(agent.visualEvidence)
  if (visualEvidence.success) picked.visualEvidence = visualEvidence.data
  const verdict = reviewVerdict.safeParse(agent.reviewVerdict)
  if (verdict.success) picked.reviewVerdict = verdict.data
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
  if (typeof agent.previewDatabaseBranch === "string" && agent.previewDatabaseBranch.trim())
    picked.previewDatabaseBranch = agent.previewDatabaseBranch.trim().slice(0, 500)
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
      const { criterionId, text, passed, status, reason, resolution, evidence, command, exitCode } = entry as {
        criterionId?: unknown
        text?: unknown
        passed?: unknown
        status?: unknown
        reason?: unknown
        resolution?: unknown
        evidence?: unknown
        command?: unknown
        exitCode?: unknown
      }
      if (!(typeof criterionId === 'string' && UUID_RE.test(criterionId)) && !(typeof text === 'string' && text.trim()))
        continue
      if (typeof passed !== "boolean") continue
      const criterion = runCriterion.safeParse({
        ...(typeof criterionId === 'string' && UUID_RE.test(criterionId) ? { criterionId } : {}),
        ...(typeof text === 'string' && text.trim() ? { text: text.trim().slice(0, 2000) } : {}),
        passed,
        ...(status !== undefined ? { status } : {}),
        ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim().slice(0, 2000) } : {}),
        ...(typeof resolution === "string" && resolution.trim() ? { resolution: resolution.trim().slice(0, 2000) } : {}),
        ...(typeof command === "string" && command.trim() ? { command: command.trim().slice(0, 2_000), ...(exitCode === null || (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) ? { exitCode } : {}) } : {}),
        ...(typeof evidence === "string"
          ? { evidence: evidence.slice(0, 10_000) }
          : {}),
      })
      if (criterion.success) criteria.push(criterion.data)
    }
    picked.criteria = criteria
  }
  return picked
}

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
    killDescendants: true,
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

/** Ordinary read-only work delivers a report without a repository build. */
function isReadOnlyTask(assignment: RunAssignment): boolean {
  // Investigations hand in a report. Acceptance checks and benchmarks still
  // run their host-owned verification against the fixed candidate.
  return runPolicy(assignment.policy).readOnly === true && assignment.kind !== "acceptance" && !assignment.benchmark
}

/**
 * The skills section the agent was actually given, as the report states it.
 * Only a run that carried skills has one; a deferred body is reported so the
 * app can show it instead of leaving the person to guess why a skill did not
 * take effect.
 */
function skillPromptOf(assignment: RunAssignment): RunSkillPrompt | undefined {
  const skills = assignment.skills
  if (!skills?.length) return undefined
  const plan = skillPromptPlan(skills)
  return {
    budgetChars: plan.budgetChars,
    usedChars: plan.usedChars,
    inlined: plan.inlined.map(entry => entry.name),
    deferred: plan.degraded.map(entry => entry.name),
  }
}

/** Existing acceptance runs remain compatible; Factory checks are exact-SHA read-only runs. */
export function fixedCandidateCheck(assignment: RunAssignment): assignment is RunAssignment & { baseBranch: string } {
  return (
    assignment.kind === "acceptance" &&
    runPolicy(assignment.policy).readOnly === true &&
    typeof assignment.baseBranch === "string" &&
    /^[a-f0-9]{40}$/.test(assignment.baseBranch)
  )
}
