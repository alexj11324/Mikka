// Private control-plane IPC. This module must never be bundled into a browser.
import { accessSnapshotReady } from './subscription-access-ready'
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { currentSubscriptionTiming, withSubscriptionWorkerTiming } from './subscription-worker-timing'
import { captureRunFailure, type RunFailure } from "@mikka/protocol/run-failure"

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
  accessProject?: string
  accessToken?: string
  accessSnapshot?: { name: string; value: string }
  enrollmentAttemptPath?: string
  enrollmentClaimPath?: string
  enrollmentGrantPath?: string
  retainEnrollmentSources?: boolean
  use?: { bindingId: string; consumerId: string; runId?: string }
  executionOnly?: boolean
  /** The worker may export one live run's access lease (never the refresh grant) for a device runner. */
  exportAccessLease?: boolean
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
  constructor(readonly code: string = "subscription_worker_unavailable", readonly failureDetails?: RunFailure) { super(code); this.name = "WorkerRefusal" }
}
function providerDiagnostic(value: unknown, provider: string): { provider: string; status?: number; error: { type: string; message?: string } } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (v.provider !== provider || Object.keys(v).some(key => !['provider', 'status', 'error'].includes(key))) return
  if (v.status !== undefined && (typeof v.status !== 'number' || !Number.isInteger(v.status) || v.status < 400 || v.status > 599)) return
  if (!v.error || typeof v.error !== 'object' || Array.isArray(v.error)) return
  const e = v.error as Record<string, unknown>
  if (Object.keys(e).some(key => !['type', 'message'].includes(key)) || typeof e.type !== 'string' || !/^[a-z_]{1,64}$/.test(e.type)) return
  if (e.message !== undefined && (typeof e.message !== 'string' || !e.message.length || e.message.length > 512)) return
  return { provider, ...(typeof v.status === 'number' ? { status: v.status } : {}), error: { type: e.type, ...(typeof e.message === 'string' ? { message: e.message } : {}) } }
}
const STORE_FAILURE = /^(secret_store_failure (GET|POST|DELETE) (no_token|network|http_\d{3})|subscription_upstream_failure (claude|codex) (transport|response|event|incomplete|convert) \d{1,3} [a-z_]{1,40})$/
const REQUEST_BYTES = '(0|[1-9]\\d{0,9})'
const REQUEST_FAILURE = new RegExp('^subscription_request_failure (claude|codex|unknown) (' +
  `input (model_invalid|payload_too_large|json_invalid) ${REQUEST_BYTES} (0|262144|1048576)|` +
  `conversion (conversion_failed|json_invalid|encode_failed|payload_too_large|request_invalid) ${REQUEST_BYTES} (0|524288|2097152)|` +
  `stream (stream_unavailable|chunk_too_large) ${REQUEST_BYTES} (0|65536))$`)
const safeCode = (value: unknown) => typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "subscription_worker_unavailable"

type WorkerIdentity = { workloadToken?: string; accessToken?: string; accessSnapshot?: WorkerConfiguration['accessSnapshot'] }
type StreamIdentity = { accessSnapshot: NonNullable<WorkerConfiguration['accessSnapshot']> }
type StreamIdentityResolver = (signal?: AbortSignal, use?: WorkerConfiguration['use'], revision?: unknown) => Promise<StreamIdentity | null>

export class SubscriptionWorkerClient {
  constructor(private readonly launch: { binary: string; args?: string[]; env?: Record<string, string> }, private readonly config: WorkerConfiguration, private readonly resolveIdentity?: (executionOnly: boolean, signal?: AbortSignal, use?: WorkerConfiguration['use'], revision?: unknown) => Promise<WorkerIdentity>, private readonly resolveStreamIdentity?: StreamIdentityResolver) {}
  forUse(use: { bindingId: string; consumerId: string; runId?: string }): SubscriptionWorkerClient {
    return new SubscriptionWorkerClient(this.launch, { ...this.config, use: { bindingId: use.bindingId, consumerId: use.consumerId, ...(use.runId ? {runId:use.runId} : {}) } }, this.resolveIdentity, this.resolveStreamIdentity)
  }

  private start(request: Record<string, unknown>, signal?: AbortSignal, chunk?: (value: string) => void, head?: (value: { contentType: string }) => void, binary?: (value: Uint8Array) => void, streamIdentity?: StreamIdentity) {
    if (signal?.aborted) throw new WorkerRefusal("subscription_cancelled")
    const id = randomUUID()
    const timing = currentSubscriptionTiming()?.startWorker(request.method)
    const child = spawn(this.launch.binary, this.launch.args ?? [], {
      // No ambient platform keys or native account state in a worker child.
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production", ...this.launch.env },
      stdio: ["pipe", "pipe", "pipe"]
    })
    // Never log raw CPA/provider errors or configuration: only the worker's fixed-shape line passes.
    createInterface({ input: child.stderr }).on("line", line => {
      if (STORE_FAILURE.test(line) || REQUEST_FAILURE.test(line)) {
        try { console.warn(JSON.stringify({ level: "warn", msg: "subscription_worker", detail: line })) }
        catch { /* diagnostics cannot change the worker result */ }
      }
    })
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
    const abort = () => { rejectPending(signal?.reason instanceof WorkerRefusal && signal.reason.code === "subscription_timeout" ? signal.reason : new WorkerRefusal("subscription_cancelled")) }
    const result = new Promise<unknown>((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        timing?.settle(error instanceof WorkerRefusal && error.code === 'subscription_cancelled' ? 'cancelled' : error ? 'error' : 'result')
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
          else if (typeof frame.chunk === "string" && chunk) { timing?.chunk(); chunk(frame.chunk) }
          else if (frame.error) {
            timing?.terminal(frame.timing, Object.hasOwn(frame, 'timing'))
            timing?.terminalTransport(frame.transportTiming, Object.hasOwn(frame, 'transportTiming'))
            timing?.terminalServiceTier(frame.serviceTier, Object.hasOwn(frame, 'serviceTier'))
            const diagnostic = providerDiagnostic(frame.providerFailure, this.config.scope.provider)
            const failure = diagnostic ? captureRunFailure({ ...diagnostic, requestBodyValues: request.payload }, { runId: this.config.use?.runId, provider: this.config.scope.provider, credential: 'subscription' }) : undefined
            finish(new WorkerRefusal(safeCode(frame.error), failure))
          }
          else if (Object.hasOwn(frame, "result")) {
            timing?.terminal(frame.timing, Object.hasOwn(frame, 'timing'))
            timing?.terminalTransport(frame.transportTiming, Object.hasOwn(frame, 'transportTiming'))
            timing?.terminalServiceTier(frame.serviceTier, Object.hasOwn(frame, 'serviceTier'))
            finish(undefined, frame.result)
          }
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
      void (async () => {
        const identityDone = timing?.beginIdentity()
        let identity: WorkerIdentity
        try {
          identity = streamIdentity ?? (this.resolveIdentity ? await withSubscriptionWorkerTiming(timing, () => this.resolveIdentity!(executionOnly, signal, this.config.use, request.revision)) : {})
          timing?.identityMode(!this.resolveIdentity && !streamIdentity ? 'static' : Object.hasOwn(identity, 'accessSnapshot') ? 'parent_snapshot' : Object.hasOwn(identity, 'accessToken') ? 'access_token' : Object.hasOwn(identity, 'workloadToken') ? 'custody_token' : 'unobserved')
        } finally { identityDone?.() }
        if (settled) return
        const resolved = { ...this.config, ...identity }
        const config = executionOnly ? { ...resolved, executionOnly: true, path: '', workloadToken: '', enrollmentAttemptPath: '', enrollmentClaimPath: '', enrollmentGrantPath: '', enableCodexOAuth: false, enableClaudeOAuth: false } : resolved
        const frames = `${JSON.stringify(config)}\n${JSON.stringify({ ...request, id })}\n`
        timing?.configWrite()
        child.stdin.write(frames)
      })().catch(() => finish(new WorkerRefusal()))
    })
    return { result, stop: abort, pause: () => child.stdout.pause(), resume: () => child.stdout.resume() }
  }
  async call<T>(method: "status" | "oauthStart" | "oauthResume" | "oauthComplete" | "oauthPoll" | "oauthHandoff" | "refresh" | "recover" | "disconnect" | "nativeAuth" | "nativeContext" | "prepare" | "quota" | "usage" | "allowance" | "models" | "cleanup", input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
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
  private async streamIdentity(revision: number, signal: AbortSignal): Promise<StreamIdentity | undefined> {
    if (!this.resolveStreamIdentity || this.config.use?.runId) { await this.call('prepare', { revision }, signal); return }
    if (signal.aborted) throw new WorkerRefusal('subscription_cancelled')
    // One original preparation budget covers both the same-call pre-read and
    // any required custody work. Execution still gets its own 275s after spawn.
    const budget = new AbortController()
    const onAbort = () => budget.abort(new WorkerRefusal('subscription_cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => budget.abort(new WorkerRefusal('subscription_timeout')), 35_000)
    timer.unref()
    let rejectWait!: (error: unknown) => void
    const stopped = new Promise<never>((_resolve, reject) => { rejectWait = reject })
    const stopWait = () => rejectWait(budget.signal.reason)
    budget.signal.addEventListener('abort', stopWait, { once: true })
    const observation = currentSubscriptionTiming()?.startStreamPreRead()
    const identityDone = observation?.worker.beginIdentity()
    try {
      const identity = await Promise.race([
        withSubscriptionWorkerTiming(observation?.worker, () => this.resolveStreamIdentity!(budget.signal, this.config.use, revision)),
        stopped,
      ])
      if (budget.signal.aborted) throw budget.signal.reason
      const ready = identity !== null && accessSnapshotReady(this.config.scope, identity.accessSnapshot)
      identityDone?.()
      observation?.finish(ready ? 'ready' : identity === null ? 'prepare_missing' : 'prepare_expiring')
      if (ready) return identity
      await Promise.race([this.start({ method: 'prepareStream', revision }, budget.signal).result, stopped])
      if (budget.signal.aborted) throw budget.signal.reason
      // Refresh/migration may have replaced the projection. The execution
      // child's existing resolver must authorize and read that new version.
      return undefined
    } catch (error) {
      const failure = budget.signal.aborted ? budget.signal.reason : error
      identityDone?.()
      observation?.finish(failure instanceof WorkerRefusal && failure.code === 'subscription_timeout' ? 'timeout' : failure instanceof WorkerRefusal && failure.code === 'subscription_cancelled' ? 'cancelled' : 'error')
      throw failure
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      budget.signal.removeEventListener('abort', stopWait)
    }
  }
  stream(revision: number, model: string, payload: unknown, signal?: AbortSignal): ReadableStream<Uint8Array> {
    currentSubscriptionTiming()?.streamEntry()
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
          const identity = await this.streamIdentity(revision, abort.signal)
          if (closed) return
          if (abort.signal.aborted) throw new WorkerRefusal('subscription_cancelled')
          const run = this.start({ method: "executeStream", revision, model, payload }, abort.signal, value => { if (!closed) controller.enqueue(encoder.encode(value)) }, undefined, undefined, identity)
          stop = run.stop
          void run.result.then(() => { if (!closed) { closed = true; controller.close() }; cleanup() }, error => { if (!closed) { closed = true; controller.error(error) }; cleanup() })
        } catch (error) { if (!closed) { closed = true; controller.error(error instanceof WorkerRefusal ? error : new WorkerRefusal()) }; cleanup() }
      },
      cancel: () => { closed = true; abort.abort(); stop?.(); cleanup() }
    })
  }
}
