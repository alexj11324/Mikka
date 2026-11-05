// Error codes that reach a person: a run's `error` and `report.summary`, which
// the thread panel and thread list show (decision 2026-11-05-0330). Each code
// lists its closed set of details (why it happened). Every code and every
// detail has a line in messages/zh-CN.json and messages/en.json under
// `RunErrors.<code>.default` and `RunErrors.<code>.<detail>`;
// scripts/error-cause-policy.mjs fails CI otherwise. Subscription refusal
// codes (lib/subscription-refusal.ts) keep their own Coordinator copy.
//
// No imports: the CI guard loads this file directly with Node.
export const USER_ERROR_CODES = {
  /** A subscription run on the bot owner's own device (subscription-local-runner.ts). */
  subscription_local_runtime_unavailable: [
    "assignment_invalid",
    "run_closed",
    "lease_refused",
    "lease_invalid",
    "model_mismatch",
    "account_changed",
    "env_not_clean",
    "adapter_start_failed",
  ],
  /** A subscription or key run on a Mikka cloud machine (subscription-hosted-runner.ts). */
  subscription_hosted_runtime_unavailable: [
    "runner_missing",
    "host_unsupported",
    "cli_missing",
    "assignment_invalid",
    "resume_mismatch",
    "run_closed",
    "context_changed",
    "workspace_invalid",
    "ledger_mismatch",
    "computer_unavailable",
    "env_not_clean",
    "credential_mismatch",
    "session_mismatch",
    "adapter_start_failed",
    "cleanup_failed",
  ],
} as const satisfies Record<string, readonly string[]>

export type UserErrorCode = keyof typeof USER_ERROR_CODES
export type UserErrorDetail<C extends UserErrorCode> = (typeof USER_ERROR_CODES)[C][number]
