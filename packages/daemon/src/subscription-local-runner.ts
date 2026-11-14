// A device run on the bot owner's subscription (orchestration.md §6; Alex,
// 2026-11-01): at run start the server hands this device the run's
// short-lived access token, never the refresh grant. The CLI gets it on a
// pipe (Claude Code) or over its own RPC (Codex), in its own run home, and
// talks to Anthropic/OpenAI directly. A natural-expiry background renewal
// prepares the next access token; both CLIs read it from memory. Tool/provider
// operations make no additional server authorization request. Run end drops the token and wipes the
// run's credential paths.
import { type RunAssignment } from "@mikka/protocol"
import { prepareSubscriptionCredentials, SubscriptionCredentialError, type PreparedSubscription } from "./subscription-credentials"
import { CodedError, findCodedError, logCodedError } from "@mikka/protocol/coded-error"
import type { UserErrorDetail } from "@mikka/protocol/user-error-codes"

import { ClaudeAdapter, type ClaudeAdapterOptions } from "./adapters/claude"
import { CodexAdapter, type CodexAdapterOptions } from "./adapters/codex"
import type { AgentSession, StartOptions } from "./adapters/types"
import { requireRunToolApproval } from "./agents/tool-approval"
import { buildChildEnv } from "./env"
import { taskExecutionEnv } from './task-env'
import type { ServerLink } from "./server-link"
import { removeRunCredentials } from "./run-scratch"

type Detail = UserErrorDetail<"subscription_local_runtime_unavailable">
/** One code for the UI; the detail says which check failed, the cause is kept (decision 2026-11-05-0330). */
const unavailable = (detail: Detail, cause?: unknown) =>
  new CodedError("subscription_local_runtime_unavailable", { detail, cause })
const isUnavailable = (error: unknown): error is CodedError =>
  error instanceof CodedError && error.code === "subscription_local_runtime_unavailable"
/** A failure inside the adapter keeps the detail of a refusal it wraps (a later lease), else adapter_start_failed. */
const startFailed = (error: unknown) => isUnavailable(error) ? error
  : error instanceof SubscriptionCredentialError ? unavailable(error.detail, error.cause ?? error)
  : unavailable((findCodedError(error, "subscription_local_runtime_unavailable")?.detail as Detail | undefined) ?? "adapter_start_failed", error)

type Common = Pick<ClaudeAdapterOptions & CodexAdapterOptions, "sandbox" | "stateDir" | "computerProvider">

export interface LocalSubscriptionHost {
  stateDir: string
  link: Required<Pick<ServerLink, "nativeLease">>
  /** Options the daemon's ordinary adapters use (sandbox, binaries, computer). */
  claude: Common & Pick<ClaudeAdapterOptions, "binary" | "ensureBinary">
  codex: Common & Pick<CodexAdapterOptions, "binary" | "ensureBinary">
}

export function createLocalSubscriptionRunner(host: LocalSubscriptionHost) {
  return {
    async start(assignment: RunAssignment, options: StartOptions): Promise<AgentSession> {
      const gate = requireRunToolApproval(options.runId, options.toolApproval)
      const selected = assignment.subscriptionBinding
      const kind = assignment.harness
      if (!selected || options.runId !== assignment.runId || (kind !== "codex" && kind !== "claude_code") ||
        selected.route !== (kind === "codex" ? "codex_cli" : "claude_code_cli") || options.continueSession) throw unavailable("assignment_invalid")
      const lifetime = new AbortController()
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        lifetime.abort()
        removeRunCredentials(host.stateDir, assignment.runId)
      }
      const offRevoke = gate.onRevoke(close)
      let prepared: PreparedSubscription | undefined
      try {
        if (!await gate.checkLive()) throw unavailable('run_closed')
        prepared = await prepareSubscriptionCredentials(assignment, {
          link: host.link, signal: lifetime.signal, onCredential: options.onCredential,
          onRefreshError: () => { options.log.warn({ event: 'subscription_refresh_deferred' }, 'Subscription renewal will retry in the background') },
        })
        const first = prepared.first
        if (options.model !== undefined && first.modelId !== options.model) throw unavailable("model_mismatch")
        const clean = taskExecutionEnv(buildChildEnv({ host: options.env, runId: options.env.MIKKA_RUN_ID === undefined ? undefined : options.runId }), options)
        if (Object.entries(options.env).some(([name, value]) => clean[name] !== value)) throw unavailable("env_not_clean")
        const next = () => prepared!.current()
        const adapter = kind === "codex"
          ? new CodexAdapter({ ...host.codex, subscriptionAuth: {
              accountId: first.accountId,
              token: async () => {
                const value = next()
                return { accessToken: value.accessToken, chatgptAccountId: value.accountId, ...(value.plan ? { chatgptPlanType: value.plan } : {}) }
              },
            } })
          : new ClaudeAdapter({ ...host.claude, subscriptionAuth: {
              accountId: first.accountId,
              automaticRefresh: true,
              token: async () => {
                const value = next()
                return { accessToken: value.accessToken, accountId: value.accountId, expiresAt: value.expiresAt }
              },
            } })
        let session: AgentSession
        try { session = await adapter.start(options) }
        catch (error) { throw startFailed(error) }
        const finish = () => { offRevoke(); prepared?.close(); close() }
        return {
          sessionId: session.sessionId,
          get runtimeModel() { return session.runtimeModel },
          async *events() {
            try { yield* session.events() } finally { finish() }
          },
          send: (text, mode) => session.send(text, mode),
          cancel: async () => { try { await session.cancel() } finally { finish() } },
        }
      } catch (error) {
        prepared?.close()
        offRevoke()
        close()
        const refusal = startFailed(error)
        logCodedError(refusal, { runId: assignment.runId, harness: kind }, options.log)
        throw refusal
      }
    },
  }
}
