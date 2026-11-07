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
  cloud_not_connected: [],
  cloud_scope_missing: [],
  cloud_server_revoked: [],
  cloud_invalid_request: ["configuration", "protocol", "state"],
  cloud_rate_limited: [],
  cloud_access_denied: ["origin", "administrator"],
  cloud_unavailable: ["network", "response", "protocol", "storage", "refresh_uncertain"],
  cloud_quota_exhausted: [],

  github_app_setup_failed: ['admin', 'origin', 'state', 'encryption', 'storage', 'configured', 'request', 'response', 'template'],
  desktop_client_update_required: [],
  desktop_session_expired: [],
  desktop_session_changed: [],
  desktop_account_limit_reached: [],
  desktop_request_failed: [],
  desktop_backend_unreachable: [],
  desktop_rpc_request_invalid: [],
  desktop_rpc_action_unknown: [],
  desktop_rpc_failed: [],
  desktop_rpc_request_rejected: [],
  desktop_rpc_response_invalid: [],
  desktop_rpc_value_invalid: [],
  factory_spec_approval_required: [],
  map_invalid_request: ["invalid_query", "invalid_token"],
  map_not_found: [],
  map_snapshot_changed: ["source_changed"],
  map_snapshot_expired: [],
  map_too_large: ["limit"],
  map_source_too_large: ["limit"],
  map_scope_conflict: [],
  map_unavailable: ["database", "signing_key"],
  map_auth_required: [],

  /** A subscription run on the bot owner's own device (subscription-local-runner.ts). */
  subscription_local_runtime_unavailable: [
    "assignment_invalid",
    "run_closed",
    "lease_refused",
    "lease_invalid",
    "model_mismatch",
    "account_changed",
    "env_not_clean",
    "cli_missing",
    "cli_version_mismatch",
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
