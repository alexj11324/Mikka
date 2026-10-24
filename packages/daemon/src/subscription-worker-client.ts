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
  enrollmentAttemptPath?: string
  enrollmentClaimPath?: string
  enrollmentGrantPath?: string
  use?: { bindingId: string; consumerId: string; runId?: string }
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
  forUse(use: { bindingId: string; consumerId: string; runId?: string }): SubscriptionWorkerClient {
    return new SubscriptionWorkerClient(this.launch, { ...this.config, use: { bindingId: use.bindingId, consumerId: use.consumerId, ...(use.runId ? {runId:use.runId} : {}) } })
  }

  private start(request: Record<string, unknown>, signal?: AbortSignal, chunk?: (value: string) => void, head?: (value: { contentType: string }) => void, binary?: (value: Uint8Array) => void) {
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
      const timer = setTimeout(() => finish(new WorkerRefusal("subscription_timeout")), chunk || binary ? 275_000 : 35_000)
      timer.unref()
      lines.on("line", line => {
        if (line.length > 262144) return finish(new WorkerRefusal())
        try {
          const frame = JSON.parse(line)
          if (frame.id !== id) return finish(new WorkerRefusal())
          if (frame.head && head && (frame.head.contentType === 'text/event-stream' || frame.head.contentType === 'application/json')) head(frame.head)
          else if (typeof frame.binaryChunk === 'string' && binary) {
            const value = Buffer.from(frame.binaryChunk, 'base64')
            if (value.toString('base64') !== frame.binaryChunk) throw new WorkerRefusal()
            binary(value)
          }
          else if (typeof frame.chunk === "string" && chunk) chunk(frame.chunk)
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
      const executionOnly = ['executeStream', 'execute', 'quota', 'nativeContext', 'nativeStream'].includes(String(request.method))
      // Execution children receive the access-store identity only. Refresh and
      // OAuth stay in custody children, with no token material in their results.
      const config = executionOnly ? { ...this.config, executionOnly: true, path: '', workloadToken: '', enrollmentAttemptPath: '', enrollmentClaimPath: '', enrollmentGrantPath: '', enableCodexOAuth: false, enableClaudeOAuth: false } : this.config
      child.stdin.write(`${JSON.stringify(config)}\n${JSON.stringify({ ...request, id })}\n`)
    })
    return { result, stop: abort, pause: () => child.stdout.pause(), resume: () => child.stdout.resume() }
  }
  async call<T>(method: "status" | "oauthStart" | "oauthComplete" | "oauthPoll" | "oauthHandoff" | "refresh" | "recover" | "disconnect" | "nativeAuth" | "nativeContext" | "prepare" | "quota" | "cleanup", input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return await this.start({ ...input, method }, signal).result as T
  }
  async nativeRequest(revision: number, payload: {path: string; headers: Record<string, string>; body: unknown}, signal?: AbortSignal): Promise<{contentType: string; body: ReadableStream<Uint8Array>}> {
    await this.call('prepare', { revision }, signal)
    let resolveHead!: (head: {contentType: string}) => void
    let rejectHead!: (error: Error) => void
    const ready = new Promise<{contentType: string}>((resolve, reject) => { resolveHead = resolve; rejectHead = reject })
    let closed = false
    let receivedHead = false
    let stop: (() => void) | undefined
    let resume: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        try {
          const run = this.start({ method: 'nativeStream', revision, payload }, signal, undefined,
          head => { if (receivedHead) throw new WorkerRefusal(); receivedHead = true; resolveHead(head) }, chunk => {
            if (!receivedHead) throw new WorkerRefusal()
            if (!closed) { controller.enqueue(chunk); if ((controller.desiredSize ?? 0) <= 0) run.pause() }
          })
          stop = run.stop
          resume = run.resume
          void run.result.then(() => {
            if (!receivedHead) rejectHead(new WorkerRefusal())
            if (!closed) { closed = true; controller.close() }
          }, error => { rejectHead(error); if (!closed) { closed = true; controller.error(error) } })
        } catch (error) { rejectHead(error instanceof Error ? error : new WorkerRefusal()); closed = true; controller.error(new WorkerRefusal()) }
      },
      pull: () => resume?.(),
      cancel: () => { closed = true; stop?.() }
    })
    try { const head = await ready; return { ...head, body } }
    catch (error) { await body.cancel().catch(() => undefined); throw error }
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
