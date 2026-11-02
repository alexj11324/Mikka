// A device run on the bot owner's subscription (orchestration.md §6; Alex,
// 2026-11-01): at run start the server hands this device the run's
// short-lived access token, never the refresh grant. The CLI gets it on a
// pipe (Claude Code) or over its own RPC (Codex), in its own run home, and
// talks to Anthropic/OpenAI directly. Codex asks again when the token
// expires; Claude Code cannot change token mid-process, so its run ends at
// expiry. Every lease request is checked anew on the server (run, device,
// binding, revocation, admission). Run end drops the token and wipes the
// run's credential paths.
import { nativeLeaseSchema, type NativeLease, type RunAssignment } from "@mikka/protocol"

import { ClaudeAdapter, type ClaudeAdapterOptions } from "./adapters/claude"
import { CodexAdapter, type CodexAdapterOptions } from "./adapters/codex"
import type { AgentSession, StartOptions } from "./adapters/types"
import { requireRunToolApproval } from "./agents/tool-approval"
import type { ServerLink } from "./server-link"
import { removeRunCredentials } from "./run-scratch"

const unavailable = () => new Error("subscription_local_runtime_unavailable")

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
        selected.route !== (kind === "codex" ? "codex_cli" : "claude_code_cli") || options.continueSession) throw unavailable()
      const lifetime = new AbortController()
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        lifetime.abort()
        removeRunCredentials(host.stateDir, assignment.runId)
      }
      const offRevoke = gate.onRevoke(close)
      const lease = async (): Promise<NativeLease> => {
        if (closed || gate.revoked || !await gate.checkLive()) throw unavailable()
        const value = nativeLeaseSchema.parse(await host.link.nativeLease(assignment.deviceId, assignment.runId, lifetime.signal))
        if (value.route !== selected.route || Date.parse(value.expiresAt) <= Date.now()) throw unavailable()
        return value
      }
      try {
        const first = await lease()
        if (options.model !== undefined && first.modelId !== options.model) throw unavailable()
        const same = (value: NativeLease) => {
          if (value.accountId !== first.accountId || value.modelId !== first.modelId) throw unavailable()
          return value
        }
        let initial: NativeLease | undefined = first
        const next = async () => {
          if (initial) { const value = initial; initial = undefined; return value }
          return same(await lease())
        }
        const adapter = kind === "codex"
          ? new CodexAdapter({ ...host.codex, subscriptionAuth: {
              accountId: first.accountId,
              token: async () => {
                const value = await next()
                return { accessToken: value.accessToken, chatgptAccountId: value.accountId, ...(value.plan ? { chatgptPlanType: value.plan } : {}) }
              },
            } })
          : new ClaudeAdapter({ ...host.claude, subscriptionAuth: {
              accountId: first.accountId,
              token: async () => {
                const value = await next()
                return { accessToken: value.accessToken, accountId: value.accountId, expiresAt: value.expiresAt }
              },
            } })
        const session = await adapter.start(options)
        const finish = () => { offRevoke(); close() }
        return {
          sessionId: session.sessionId,
          get runtimeModel() { return session.runtimeModel },
          async *events() {
            try { yield* session.events() } finally { finish() }
          },
          send: text => session.send(text),
          cancel: async () => { try { await session.cancel() } finally { finish() } },
        }
      } catch {
        offRevoke()
        close()
        throw unavailable()
      }
    },
  }
}
