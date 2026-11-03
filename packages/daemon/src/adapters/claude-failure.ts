// Why a subscription turn failed, in words that can carry no credential.
// The run's error names a class from fixed lists only; the native text (result,
// errors, stderr) goes to the daemon log, and only after `redactDiagnostic`.
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"

const ASSISTANT_ERRORS = new Set([
  "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required",
  "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error",
  "unknown", "max_output_tokens", "cloud_credential_error",
])

/** The CLI's own terminal reasons that say more than "the API failed". */
const TERMINAL_REASONS = new Set([
  "blocking_limit", "rapid_refill_breaker", "prompt_too_long", "image_error", "model_error",
  "malformed_tool_use_exhausted", "aborted_streaming", "aborted_tools", "stop_hook_prevented",
  "hook_stopped", "max_turns", "budget_exhausted", "structured_output_retry_exhausted",
  "tool_deferred_unavailable", "turn_setup_failed",
])

const SUBTYPES: Record<string, string> = {
  error_max_turns: "max_turns",
  error_max_budget_usd: "budget_exhausted",
  error_during_execution: "execution_error",
  error_max_structured_output_retries: "structured_output_retry_exhausted",
}

/** The CLI exited (or the SDK stream broke) before the turn's result. */
export const CLI_EXITED_EARLY = "cli_exited_early"

function field(message: object, key: string): unknown {
  return (message as Record<string, unknown>)[key]
}

/**
 * A failed result's class: the CLI's specific terminal reason, else the API
 * error the turn's assistant message carried, else the result subtype.
 */
export function subscriptionFailureCategory(
  result: SDKResultMessage,
  assistantError: unknown,
): string {
  const terminal = field(result, "terminal_reason")
  if (typeof terminal === "string" && TERMINAL_REASONS.has(terminal)) return terminal
  if (typeof assistantError === "string")
    return `api_error:${ASSISTANT_ERRORS.has(assistantError) ? assistantError : "unknown"}`
  if (result.subtype !== "success") return SUBTYPES[result.subtype] ?? "unknown"
  const status = field(result, "api_error_status")
  return Number.isInteger(status) ? `api_error:http_${status}` : "api_error"
}

/** The log fields of a failed result; free text only through `redactDiagnostic`. */
export function resultDiagnostics(result: SDKResultMessage, secrets: readonly string[]) {
  const text = result.subtype === "success" ? result.result : result.errors.join("; ")
  const status = field(result, "api_error_status")
  const terminal = field(result, "terminal_reason")
  return {
    subtype: result.subtype,
    is_error: result.is_error,
    ...(typeof terminal === "string" ? { terminal_reason: terminal.slice(0, 64) } : {}),
    ...(Number.isInteger(status) ? { api_error_status: status } : {}),
    result: redactDiagnostic(text ?? "", secrets, 1000),
  }
}

/**
 * Removes credentials from native diagnostic text: the exact values the
 * daemon knows, then anything shaped like a token or a secret assignment.
 */
export function redactDiagnostic(text: string, secrets: readonly string[], max = 2000): string {
  let out = String(text).replace(/\0/g, "")
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[REDACTED]")
  out = out
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9._-]{8,}/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/\bgh[opusr]_[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/\b(e2b|orv)_[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key|authorization|cookie)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b|\[REDACTED\])[^\s"',;&]+/gi,
      "$1$2[REDACTED]",
    )
  return out.slice(-max).trim()
}
