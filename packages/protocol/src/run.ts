// Run completion (ADR 0012, ADR 0016). The daemon only executes runs and
// reports how each one ended; it never writes issue state.
// `POST /v1/runs/:runId/complete` is the only path that moves an issue to
// in_review, and only for `submitted` with the daemon's verify not failed.
//
// This file is the single owner of the stop reasons and the handoff report:
// the daemon builds `RunReport`s with it, the server validates them with it,
// and `agent_run.report` stores exactly this shape.
import { z } from "zod"

export const RUN_QUESTION_KINDS = [
  "context",
  "decision",
  "permission",
  "external",
] as const
export const runQuestion = z
  .object({
    questionId: z.uuid(),
    kind: z.enum(RUN_QUESTION_KINDS).default("decision"),
    question: z.string().trim().min(1).max(4000),
    context: z.string().trim().max(4000).optional(),
    options: z.array(z.string().trim().min(1).max(4000)).max(20).default([]),
  })
  .strict()
export type RunQuestion = z.infer<typeof runQuestion>

import { planHandoff } from "./plan"

/** Why a run stopped. Must match `agent_run.stop_reason` in packages/db. */
export const RUN_STOP_REASONS = [
  "submitted",
  "turn_ended",
  "asked_human",
  "blocked",
  "cancelled",
  "error",
  "timeout",
  "device_lost",
] as const
export const runStopReason = z.enum(RUN_STOP_REASONS)
export type RunStopReason = z.infer<typeof runStopReason>

const shortList = z.array(z.string().max(1_000)).max(5_000)

export const VERIFY_STATUSES = ["passed", "failed", "not_run"] as const
export const verifyStatus = z.enum(VERIFY_STATUSES)
export type VerifyStatus = z.infer<typeof verifyStatus>

/**
 * The daemon's commit and push of a verified hand-in (ADR 0024). The
 * orchestrator opens or updates the issue's pull request from `branch` and
 * waits for CI on `commit`.
 */
export const runPublish = z.object({
  /** Where the commit went: the issue's branch, or the run's own. */
  branch: z.string().max(500),
  /** Null when nothing was committed (no changes, or the commit failed). */
  commit: z.string().max(100).nullable(),
  pushed: z.boolean(),
  remote: z.string().max(200).nullable(),
  /**
   * Why nothing was pushed when that was expected: the agent changed
   * nothing, or the repo has not approved pushes. Absent with
   * `pushed: false` means the commit or the push failed (see `note`).
   */
  skipped: z.enum(["no_changes", "not_approved"]).optional(),
  note: z.string().max(2_000).optional(),
})
export type RunPublish = z.infer<typeof runPublish>

/**
 * The handoff report sent with every run completion. The agent fills what
 * it can through its submit / ask / blocker call (summary, open questions,
 * next step, blocker and the optional fields below); the daemon always adds
 * the files changed in the worktree and its own verify result, so an agent
 * cannot report its own verify as passed.
 */
export const runReport = z.object({
  /** What was done, in a few sentences. Empty when the run crashed early. */
  summary: z.string().max(10_000),
  /** Paths relative to the worktree root (from `git status`). */
  filesChanged: shortList,
  /** The daemon's run of the issue's verify command after a submit. */
  verify: z.object({
    status: verifyStatus,
    command: z.string().max(2_000).optional(),
    /** Actual process outcome from the daemon, never the agent. */
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(100).nullable().optional(),
    timedOut: z.boolean().optional(),
    /** Tail of the command output. */
    output: z.string().max(10_000).optional(),
  }),
  openQuestions: z.array(z.string().max(2_000)).max(50),
  /** What should happen next, from the agent's point of view. */
  question: runQuestion.optional(),
  nextStep: z.string().max(2_000).nullable(),
  /** For `blocked`: the external condition, e.g. `quota_exhausted`. */
  blockedOn: z.string().max(500).optional(),
  /** Daemon-owned receipt for an exact, unchanged read-only candidate. */
  check: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    readOnly: z.literal(true),
  }).optional(),
  /** Acceptance criteria the agent checked, with evidence. */
  criteria: z
    .array(
      z.object({
        criterionId: z.uuid().optional(),
        text: z.string().max(2_000).optional(),
        passed: z.boolean(),
        evidence: z.string().max(10_000).optional(),
      })
    )
    .max(200)
    .optional(),
  /**
   * A `plan` run's hand-in: the spec it wrote and the split it proposes for
   * it (ADR ORV-205). Only the daemon sets this, and only for a `plan` run.
   */
  plan: planHandoff.optional(),
  interfacesProduced: shortList.optional(),
  knownIssues: shortList.optional(),
  notesForNext: z.string().max(10_000).optional(),
  /** Set by the daemon after a verified submit; never by the agent. */
  publish: runPublish.optional(),
  followUps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(500),
        goal: z.string().max(2_000).optional(),
        reason: z.string().max(2_000).optional(),
      })
    )
    .max(50)
    .optional(),
})
export type RunReport = z.infer<typeof runReport>

/** An empty report, e.g. for a run that failed before the agent spoke. */
export function emptyRunReport(summary = ""): RunReport {
  return {
    summary,
    filesChanged: [],
    verify: { status: "not_run" },
    openQuestions: [],
    nextStep: null,
  }
}

export const runCompletePath = (runId: string) =>
  `/v1/runs/${encodeURIComponent(runId)}/complete`
export const RUN_COMPLETE_ROUTE = "/v1/runs/:runId/complete"

/** What the daemon sends: always with a report. */
export const runCompletion = z.object({
  stopReason: runStopReason,
  report: runReport,
})
export type RunCompletion = z.infer<typeof runCompletion>

/**
 * What the route accepts. A submission must carry its report (the verify
 * result decides whether it reaches review); other endings may omit it.
 */
export const runCompleteRequest = z
  .object({ stopReason: runStopReason, report: runReport.optional() })
  .refine((body) => body.stopReason !== "submitted" || body.report, {
    message: "A submitted run needs a report.",
    path: ["report"],
  })
export type RunCompleteRequest = z.infer<typeof runCompleteRequest>

/**
 * A submission goes to review unless its verify failed. One without a verify
 * command (`not_run`) is reviewed by a person, who decides what it is worth;
 * a failed verify goes back to the agent instead.
 */
export function reachesReview(
  stopReason: RunStopReason,
  report: Pick<RunReport, "verify"> | undefined
): boolean {
  return (
    stopReason === "submitted" && !!report && report.verify.status !== "failed"
  )
}

export interface RunCompleteResponse {
  run: { id: string; status: string; stopReason: RunStopReason }
  issue: {
    id: string
    status: string
    waitingOn: string
    waitReason: string | null
  }
  /** True when this exact completion had already been recorded. */
  replayed: boolean
}
