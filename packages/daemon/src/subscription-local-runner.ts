// A device run on the bot owner's subscription (orchestration.md §3, §6;
// option (a), 2026-11-01): the owner's token never reaches the device. The
// daemon opens the existing native broker for the run and a loopback HTTP
// endpoint in front of it; the CLI, in its own run home, sends its model
// requests there with a placeholder token, and the server adds the
// credential to each request after checking the run, the binding,
// revocation and admission. Run end closes both; nothing is left to wipe.
import { createServer, request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

import { nativeBrokerContextSchema, type RunAssignment } from "@mikka/protocol"

import { ClaudeAdapter, type ClaudeAdapterOptions } from "./adapters/claude"
import { CodexAdapter, type CodexAdapterOptions } from "./adapters/codex"
import type { AgentSession, StartOptions } from "./adapters/types"
import { requireRunToolApproval } from "./agents/tool-approval"
import type { ServerLink } from "./server-link"
import { createNativeSubscriptionBroker, NATIVE_AUTH_PLACEHOLDER } from "./subscription-native-broker"
import { removeRunCredentials } from "./run-scratch"

const unavailable = () => new Error("subscription_local_runtime_unavailable")

type Common = Pick<ClaudeAdapterOptions & CodexAdapterOptions, "sandbox" | "stateDir" | "computerProvider" | "networkCeiling">

export interface LocalSubscriptionHost {
  stateDir: string
  link: Required<Pick<ServerLink, "nativeContext" | "nativeRequest">>
  /** Options the daemon's ordinary adapters use (sandbox, binaries, computer). */
  claude: Common & Pick<ClaudeAdapterOptions, "binary" | "ensureBinary">
  codex: Common & Pick<CodexAdapterOptions, "binary" | "ensureBinary">
  /** How often a live run rechecks its binding with the server. */
  checkMs?: number
}

/** The loopback endpoint the CLI calls; it forwards to the broker's socket. */
export async function brokerEndpoint(socketPath: string, kind: "claude_code" | "codex"): Promise<{ url: string; server: Server }> {
  const server = createServer((incoming, response) => {
    if (incoming.method !== "POST" || !incoming.url) return void response.writeHead(404).end()
    // Codex posts to `<chatgpt_base_url>/codex/responses`; the broker takes `/responses`.
    const path = kind === "codex" && incoming.url.split("?")[0].endsWith("/responses") ? "/responses" : incoming.url
    const upstream = httpRequest({ socketPath, method: "POST", path, headers: incoming.headers }, result => {
      response.writeHead(result.statusCode ?? 502, { "content-type": result.headers["content-type"] ?? "application/json" })
      result.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    incoming.pipe(upstream)
    response.on("close", () => upstream.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
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
      let closing: Promise<void> | undefined
      let timer: ReturnType<typeof setInterval> | undefined
      let broker: Awaited<ReturnType<typeof createNativeSubscriptionBroker>> | undefined
      let endpoint: Awaited<ReturnType<typeof brokerEndpoint>> | undefined
      const live = async () => {
        if (closed || gate.revoked) throw unavailable()
        if (!await gate.checkLive()) { gate.revoke(); throw unavailable() }
      }
      const close = () => closing ??= (async () => {
        closed = true
        clearInterval(timer)
        lifetime.abort()
        endpoint?.server.closeAllConnections()
        await new Promise(resolve => endpoint ? endpoint.server.close(resolve) : resolve(undefined))
        await broker?.close()
        removeRunCredentials(host.stateDir, assignment.runId)
      })()
      const offRevoke = gate.onRevoke(() => { void close().catch(() => undefined) })
      try {
        await live()
        const context = async () => nativeBrokerContextSchema.parse(await host.link.nativeContext(assignment.deviceId, assignment.runId, lifetime.signal))
        const first = await context()
        if (first.route !== selected.route || (options.model !== undefined && first.modelId !== options.model)) throw unavailable()
        const check = async () => {
          await live()
          const current = await context()
          if (current.revision !== first.revision || current.accountId !== first.accountId || current.route !== first.route || current.modelId !== first.modelId) throw unavailable()
          return current
        }
        broker = await createNativeSubscriptionBroker({
          root: join(host.stateDir, "native-brokers"),
          revision: first.revision,
          check,
          worker: {
            nativeRequest: async (_revision, payload, signal) =>
              host.link.nativeRequest(assignment.deviceId, assignment.runId, payload, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])),
          },
        })
        endpoint = await brokerEndpoint(broker.socket, kind)
        const adapter = kind === "codex"
          ? new CodexAdapter({ ...host.codex, modelEndpoint: endpoint.url, subscriptionAuth: {
              accountId: first.accountId,
              verify: async () => { await check() },
              token: async () => {
                const current = await check()
                return { accessToken: NATIVE_AUTH_PLACEHOLDER, chatgptAccountId: current.accountId, ...(current.plan ? { chatgptPlanType: current.plan } : {}) }
              },
            } })
          : new ClaudeAdapter({ ...host.claude, modelEndpoint: endpoint.url, subscriptionAuth: {
              brokered: true,
              accountId: first.accountId,
              verify: async () => { await check() },
              token: async () => {
                const current = await check()
                return { accessToken: NATIVE_AUTH_PLACEHOLDER, accountId: current.accountId, expiresAt: current.expiresAt }
              },
            } })
        const session = await adapter.start(options)
        let checking = false
        if (!closed) timer = setInterval(() => {
          if (checking || closed) return
          checking = true
          void check()
            .catch(async () => { try { await session.cancel() } finally { await close() } })
            .finally(() => { checking = false })
            .catch(() => undefined)
        }, host.checkMs ?? 5000)
        timer?.unref()
        const finish = async () => { offRevoke(); await close() }
        return {
          sessionId: session.sessionId,
          get runtimeModel() { return session.runtimeModel },
          async *events() {
            try { yield* session.events() } finally { await finish() }
          },
          send: async text => { await check(); await session.send(text) },
          cancel: async () => { try { await session.cancel() } finally { await finish() } },
        }
      } catch {
        offRevoke()
        await close()
        throw unavailable()
      }
    },
  }
}
