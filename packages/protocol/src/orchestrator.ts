// The orchestrator's knobs and the "next step" vocabulary (ADR 0012, ADR
// 0017). The server's reconciler reads the settings; the desktop app reads
// the wait details to render each issue's always-set next-step label.
import { z } from "zod"

const minutes = (n: number) => n * 60_000

/**
 * Per-project orchestrator settings (`project.orchestration`). Every field is
 * optional in storage; `orchestratorSettings()` fills the defaults Alex
 * approved on 2026-10-16.
 */
export const orchestratorSettingsSchema = z.object({
  /** "Continue" prompts after a turn ended without a submit. */
  maxContinuations: z.number().int().min(0).max(20).default(3),
  /** Resumes after the CLI crashed, before one fresh session. */
  maxCrashRetries: z.number().int().min(0).max(20).default(3),
  /** Fix rounds after the daemon's verify failed. */
  maxFixAttempts: z.number().int().min(0).max(20).default(3),
  /** "You seem stuck" prompts after a run stalled. */
  maxStallRecoveries: z.number().int().min(0).max(20).default(2),
  /** No progress for this long while the lease is fresh = stalled. */
  stalledAfterMs: z.number().int().min(minutes(1)).default(minutes(10)),
  /** A device offline this long is handed to a person (no auto switch). */
  deviceOfflineEscalateMs: z.number().int().min(0).default(minutes(30)),
  /** An unanswered question frees its concurrency slot after this. */
  questionSlotReleaseMs: z
    .number()
    .int()
    .min(0)
    .default(minutes(24 * 60)),
  /** Automatic dispatches per issue per hour before a person looks. */
  maxDispatchesPerHour: z.number().int().min(1).max(100).default(6),
  /** Wait before resuming a run that hit its quota (no reset time known). */
  quotaBackoffMs: z.number().int().min(0).default(minutes(15)),
  /**
   * How often an issue waiting on its pull request or CI asks GitHub again
   * when no webhook arrived (ADR 0024).
   */
  ciRecheckMs: z.number().int().min(30_000).default(minutes(2)),
  /** A pushed commit with no checks after this long has no CI: it passes. */
  ciNoChecksMs: z.number().int().min(0).default(minutes(5)),
  /** CI still running after this long goes to a person. */
  ciTimeoutMs: z.number().int().min(minutes(5)).default(minutes(120)),
  /** Remote URL of the repo this project's issues run in. */
  repoUrl: z.string().max(2_000).optional(),
})
export type OrchestratorSettings = z.infer<typeof orchestratorSettingsSchema>
export type StoredOrchestratorSettings = z.input<
  typeof orchestratorSettingsSchema
>

/** Settings with defaults; unknown or invalid stored values fall back. */
export function orchestratorSettings(stored: unknown): OrchestratorSettings {
  const parsed = orchestratorSettingsSchema.safeParse(stored ?? {})
  return parsed.success ? parsed.data : orchestratorSettingsSchema.parse({})
}

/** Runs a device takes at once unless `device.max_concurrent_runs` says so. */
export const DEFAULT_DEVICE_CONCURRENCY = 3

/** Back-off before each crash resume (Symphony-style, capped at 5 min). */
export const CRASH_BACKOFF_MS = [10_000, 60_000, minutes(5)] as const

/** How often waiting issues are looked at again. */
export const RECHECK_MS = 60_000
export const UPSTREAM_RECHECK_MS = minutes(5)

/**
 * Waiting on a person: nobody else can move the issue, so the UI offers an
 * action and the inbox notifies the assignee.
 */
export const PERSON_WAIT_DETAIL_CODES = [
  "review",
  // The planner wrote a spec; a person approves it, then its split (ADR ORV-205).
  "plan_review",
  "question",
  "verify_failed",
  "no_verify_command",
  "no_submit",
  "stalled",
  "crashed",
  "blocked",
  "auth_expired",
  "device_offline",
  "agent_no_device",
  "no_repo",
  "repo_ambiguous",
  "no_criteria",
  "dispatch_loop",
  "manual_advance",
  "push_failed",
  "pr_failed",
  "pr_closed",
  "ci_failed",
  "ci_timeout",
  "acceptance_failed",
] as const

/** Waiting on something external: it resolves without a person. */
export const EXTERNAL_WAIT_DETAIL_CODES = [
  "pr_opening",
  "ci_pending",
  "upstream",
  "device_offline_recent",
  "capacity",
  "file_overlap",
  "retry_backoff",
  "quota",
] as const

/**
 * Why an issue waits, in detail (`issue.wait_detail`). `code` picks the
 * label; `params` fill it. The UI translates the code; nothing here is
 * user-facing text.
 */
export const WAIT_DETAIL_CODES = [
  ...PERSON_WAIT_DETAIL_CODES,
  ...EXTERNAL_WAIT_DETAIL_CODES,
] as const
export type WaitDetailCode = (typeof WAIT_DETAIL_CODES)[number]

/** True when only a person can end this wait. */
export function isPersonWaitCode(code: string): boolean {
  return (PERSON_WAIT_DETAIL_CODES as readonly string[]).includes(code)
}

export const waitDetailSchema = z.object({
  code: z.enum(WAIT_DETAIL_CODES),
  params: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.array(z.string()),
        // `repo_ambiguous`: the repos a person can pick from.
        z.array(z.record(z.string(), z.string())),
      ])
    )
    .optional(),
})
export type WaitDetail = z.infer<typeof waitDetailSchema>

/**
 * The CI result for one commit of an issue's pull request
 * (`external_link.checks`, ADR 0024), from GitHub check runs and commit
 * statuses together. `none`: nothing reported yet.
 */
export const prChecksSchema = z.object({
  state: z.enum(["pending", "success", "failure", "none"]),
  /** Failed checks, for the fix round's brief and the issue page. */
  failing: z
    .array(
      z.object({
        name: z.string().max(500),
        summary: z.string().max(4_000).optional(),
        url: z.string().max(2_000).optional(),
      })
    )
    .max(50),
  total: z.number().int().min(0),
})
export type PrChecks = z.infer<typeof prChecksSchema>

/** Why an issue reaches review without a pull request. */
export const NO_PR_REASONS = [
  /** The server has no GitHub App, or the repo is not on GitHub. */
  "no_github",
  /** The repo has not approved pushes, so the commit stayed local. */
  "not_pushed",
  /** The agent changed nothing. */
  "no_changes",
  /** The workspace or repository turned the pull request requirement off. */
  "not_required",
] as const
export type NoPrReason = (typeof NO_PR_REASONS)[number]

// ---------------------------------------------------------------------------
// Review rules (ORV-172, ADR ORV-172). The gate an issue passes between a
// verified hand-in and In Review is a workspace setting, with one override per
// repository: whether a pull request and green CI are required, which harness
// runs the read-only check, and the branch and pull request text Orvilo uses.
// The defaults are exactly the behaviour of ADR 0024 and ADR 0046, so a
// workspace that never opens the settings page sees no change.
// ---------------------------------------------------------------------------

/** The branch every run of an issue pushes to (ADR 0024). */
export const DEFAULT_BRANCH_TEMPLATE = "orvilo/{team}-{number}"

/** Variables a branch template may use. `{number}` is required. */
export const BRANCH_TEMPLATE_VARS = ["{team}", "{number}"] as const

/**
 * A branch name may not contain these: git refuses them, and a template that
 * produces one would fail at push time, far from the settings page.
 */
const BRANCH_FORBIDDEN = /[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$/
const BRANCH_FORBIDDEN_HINT =
  "No spaces or ~ ^ : ? * [ \\ .. @{ //, and no leading or trailing /."

/** Characters a terminal or a git ref would reject that `\s` does not cover. */
const hasControlCharacter = (value: string) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })

/**
 * A branch template: text with `{team}` and `{number}`. `{number}` is
 * required, or every issue in the workspace would push to one branch.
 */
export const branchTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => value.includes("{number}"), {
    message: "The template must contain {number}.",
  })
  .refine(
    (value) => !BRANCH_FORBIDDEN.test(value) && !hasControlCharacter(value),
    { message: BRANCH_FORBIDDEN_HINT }
  )

/** Variables a pull request body template may use. */
export const PR_BODY_TEMPLATE_VARS = ["{key}", "{title}", "{summary}"] as const

export const prBodyTemplateSchema = z.string().max(20_000).nullable().optional()

/** The harnesses a review rule may name for the read-only check (ADR 0046). */
export const REVIEW_CHECK_HARNESSES = [
  "claude_code",
  "codex",
  "cursor",
] as const

/**
 * The review gate of one scope. A row left at its defaults behaves exactly
 * like the code before this setting existed.
 */
export const reviewRuleSchema = z.object({
  /** In Review needs an open pull request for the issue's branch (ADR 0024). */
  requirePullRequest: z.boolean().default(true),
  /** ... and green CI on it. Ignored when no pull request is required. */
  requireCi: z.boolean().default(true),
  /**
   * The harness that must run the read-only check (ADR 0046). Null: any
   * second agent on the device. A configured harness the device does not run
   * means no check runs, exactly as if the device had no second agent.
   */
  checkHarness: z.enum(REVIEW_CHECK_HARNESSES).nullable().default(null),
  branchTemplate: branchTemplateSchema.default(DEFAULT_BRANCH_TEMPLATE),
  /** `{key}`, `{title}` and `{summary}`; null keeps Orvilo's default text. */
  prBodyTemplate: prBodyTemplateSchema.default(null),
})
export type ReviewRule = z.infer<typeof reviewRuleSchema>
export type StoredReviewRule = z.input<typeof reviewRuleSchema>

/** The defaults every workspace starts from. */
export const DEFAULT_REVIEW_RULE: ReviewRule = reviewRuleSchema.parse({})

/** A stored rule with defaults filled in; an invalid value falls back. */
export function reviewRule(stored: unknown): ReviewRule {
  const parsed = reviewRuleSchema.safeParse(stored ?? {})
  return parsed.success ? parsed.data : DEFAULT_REVIEW_RULE
}

/** The branch name a template makes, with `{team}` and `{number}` filled. */
export function issueBranch(
  teamKey: string,
  number: number,
  template: string = DEFAULT_BRANCH_TEMPLATE
): string {
  const key = teamKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const usable = branchTemplateSchema.safeParse(template)
  const shape = usable.success ? usable.data : DEFAULT_BRANCH_TEMPLATE
  return shape.replaceAll("{team}", key).replaceAll("{number}", String(number))
}

/**
 * The pull request body, from a workspace's template or Orvilo's own text.
 * A placeholder with no value becomes empty rather than staying literal.
 */
export function pullRequestBody(
  template: string | null | undefined,
  vars: { key: string; title: string; summary?: string | null }
): string {
  if (!template) {
    return [
      vars.summary?.trim(),
      `Opened by Orvilo for ${vars.key}. Later fix rounds push to this branch.`,
    ]
      .filter(Boolean)
      .join("\n\n---\n\n")
      .slice(0, 60_000)
  }
  return template
    .replaceAll("{key}", vars.key)
    .replaceAll("{title}", vars.title)
    .replaceAll("{summary}", vars.summary?.trim() ?? "")
    .trim()
    .slice(0, 60_000)
}
