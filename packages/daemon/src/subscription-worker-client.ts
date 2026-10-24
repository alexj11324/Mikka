// Private control-plane IPC. This module must never be bundled into a browser.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"

export interface CredentialScope {
  ownerId: string
  workspaceId: string
  connectionId: string
  provider: "codex" | "claude"
}
export interface WorkerConfiguration {
  scope: CredentialScope
  databaseUrl: string
  infisicalOrigin: string
  project: string
  environment: string
  path: string
  workloadToken: string
  accessPath?: string
  accessToken?: string
  use?: { bindingId: string; consumerId: string }
  executionOnly?: boolean
  enableCodexOAuth?: boolean
  enableRuntime?: boolean
  enablePlainModels?: boolean
  enableClaudeOAuth?: boolean
  claudeRedirectUri?: string
  redirectUri?: string
}
export interface WorkerMetadata { id: string; provider: string; state: string; revision: number; credentialVersion: number; cleanup?: { pending: number; failed: number; providerRevocation: 'not_implemented'; uncertainCreates: number } }
export interface NativeLease { accessToken: string; accountId?: string; chatgptAccountId?: string; chatgptPlanType?: string; expiresAt?: string }

export class WorkerRefusal extends Error {
  constructor(readonly code: string = "subscription_worker_unavailable") { super(code) }
}
const safeCode = (value: unknown) => typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "subscription_worker_unavailable"

export class SubscriptionWorkerClient {
  constructor(private readonly launch: { binary: string; args?: string[]; env?: Record<string, string> }, private readonly config: WorkerConfiguration) {}
  forUse(use: { bindingId: string; consumerId: string }): SubscriptionWorkerClient {
    return new SubscriptionWorkerClient(this.launch, { ...this.config, use: { bindingId: use.bindingId, consumerId: use.consumerId } })
  }

  private start(request: Record<string, unknown>, signal?: AbortSignal, chunk?: (value: string) => void) {
    if (signal?.aborted) throw new WorkerRefusal("subscription_cancelled")
    const id = randomUUID()
    const child = spawn(this.launch.binary, this.launch.args ?? [], {
      // No ambient platform keys or native account state in a worker child.
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production", ...this.launch.env },
      stdio: ["pipe", "pipe", "pipe"]
    })
    child.stderr.resume() // Never log raw CPA/provider errors or configuration.
    const lines = createInterface({ input: child.stdout })
    let settled = false
    let rejectPending: (error: Error) => void = () => undefined
    const stop = () => {
      lines.close(); child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        // CPA refresh can outlive cancellation for 30s, then persistence has a
        // 20s capture budget. Allow that bounded result publication to finish.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 55_000); killTimer.unref()
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const abort = () => { rejectPending(new WorkerRefusal("subscription_cancelled")) }
    const result = new Promise<unknown>((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        stop()
        error ? reject(error) : resolve(value)
      }
      rejectPending = error => finish(error)
      const timer = setTimeout(() => finish(new WorkerRefusal("subscription_timeout")), chunk ? 275_000 : 35_000)
      timer.unref()
      lines.on("line", line => {
        if (line.length > 262144) return finish(new WorkerRefusal())
        try {
          const frame = JSON.parse(line)
          if (frame.id !== id) return finish(new WorkerRefusal())
          if (typeof frame.chunk === "string" && chunk) chunk(frame.chunk)
          else if (frame.error) finish(new WorkerRefusal(safeCode(frame.error)))
          else if (Object.hasOwn(frame, "result")) finish(undefined, frame.result)
          else finish(new WorkerRefusal())
        } catch { finish(new WorkerRefusal()) }
      })
      child.on("error", () => finish(new WorkerRefusal()))
      child.on("exit", () => { clearTimeout(killTimer); if (!settled) finish(new WorkerRefusal()) })
      child.stdin.on("error", () => finish(new WorkerRefusal()))
      signal?.addEventListener("abort", abort, { once: true })
      // The first frame is private host configuration, never a process argument.
      const executionOnly = request.method === 'executeStream' || request.method === 'execute' || request.method === 'quota'
      // Execution children receive the access-store identity only. Refresh and
      // OAuth stay in custody children, with no token material in their results.
      const config = executionOnly ? { ...this.config, executionOnly: true, path: '', workloadToken: '', enableCodexOAuth: false, enableClaudeOAuth: false } : this.config
      child.stdin.write(`${JSON.stringify(config)}\n${JSON.stringify({ ...request, id })}\n`)
    })
    return { result, stop: abort }
  }
  async call<T>(method: "status" | "oauthStart" | "oauthComplete" | "oauthPoll" | "oauthHandoff" | "refresh" | "recover" | "disconnect" | "nativeAuth" | "prepare" | "quota" | "cleanup", input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return await this.start({ ...input, method }, signal).result as T
  }
  stream(revision: number, model: string, payload: unknown, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const abort = new AbortController()
    const forwardAbort = () => abort.abort(signal?.reason)
    if (signal?.aborted) forwardAbort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', forwardAbort)
    let stop: (() => void) | undefined
    let closed = false
    return new ReadableStream({
      start: async controller => {
        try {
          await this.call("prepare", { revision }, abort.signal)
          if (closed || abort.signal.aborted) return
          const run = this.start({ method: "executeStream", revision, model, payload }, abort.signal, value => { if (!closed) controller.enqueue(encoder.encode(value)) })
          stop = run.stop
          void run.result.then(() => { if (!closed) { closed = true; controller.close() }; cleanup() }, error => { if (!closed) { closed = true; controller.error(error) }; cleanup() })
        } catch { if (!closed) { closed = true; controller.error(new WorkerRefusal()) }; cleanup() }
      },
      cancel: () => { closed = true; abort.abort(); stop?.(); cleanup() }
    })
  }
}
