import { nativeCoordinatorClaimSchema, nativeCoordinatorToolResultSchema, type NativeCoordinatorCommand } from "@mikka/protocol/coordinator"
import { WORKSPACE_REQUEST_HEADER, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-review'
// HTTP transport for `ServerLink`: the routes apps/server serves for the
// daemon (ADR 0016). Paths and payloads come from packages/protocol
// (`devicePaths`, `runCompletePath` and their zod schemas); responses are
// decoded with those schemas, so a server that drifts from the contract
// fails loudly instead of corrupting the journal.
//
// Credentials: every route, the device's and its runs' (events, patch,
// complete), uses the daemon's device session (Bearer). Agents hold no server
// credential; they hand in to the daemon, which reports for them.
//
// Status handling: network errors, 5xx and 429 mean "try again later"
// (`ServerUnreachableError`, the outbox keeps the item); 409 on a claim is
// `RunNotPinnedHereError`; any other 4xx is a refusal (`DaemonError`) that
// retrying cannot fix.
import { z } from "zod"
import { chatFileDownloadSchema, chatFileTransferSchema, CHAT_FILE_MAX_BYTES } from '@mikka/protocol/chat-attachments'
import { ToolApprovalGate, type RunControlMode } from "./agents/tool-approval"
import type { ServerDecide, ServerDecisionAnswer } from "./server-decision"
import { POLICY_SNAPSHOT_HEADER, POLICY_SNAPSHOT_VERSION, POLICY_SNAPSHOT_REFRESH_MS, policyDistributionContextSchema, policyIssuer, signedPolicySnapshotSchema } from '@mikka/protocol/policy-snapshot'
import { TASK_SECRETS_HEADER, TASK_SECRETS_VERSION } from '@mikka/protocol/task-secrets'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { SKILL_ARTIFACT_HEADER, TEAM_SKILL_HEADER, skillReceiptRevalidationSchema } from '@mikka/protocol/skill'
import { TASK_MCP_HEADER, TASK_MCP_VERSION } from '@mikka/protocol'
import { nativeBrokerContextSchema, nativeLeaseSchema, SUBSCRIPTION_MODEL_CATALOGUE_HEADER, type NativeBrokerRequest } from '@mikka/protocol/subscription'
import { computerSyncPath, computerSyncResponse, type LocalComputerRequest } from '@mikka/protocol/computer'
import { captureCompleteResponse, capturePaths, captureUploadResponse, screenCaptureResponse, type CaptureUploadRequest, type CaptureUploadResponse, type ScreenCaptureRequest } from '@mikka/protocol/capture'

import {
  CLIENT_VERSION_HEADER,
  REPO_ORIGIN_HEADER,
  PROJECT_ENVIRONMENT_HEADER,
  RECOVERY_WORKTREE_HEADER,
  MODEL_CREDENTIAL_HEADER,
  RUN_CREDENTIALS_HEADER,
  INITIAL_REPOSITORY_HEADER,
  MAILBOX_NOTICE_HEADER,
  DAEMON_RPC_ERRORS,
  devicePaths,
  fsPaths,
  fsRequestsResponse,
  type FsResult,
  deviceRegistered,
  deviceReposResponse,
  deviceGatewaySchema,
  heartbeatResultSchema,
  pendingRunsResponse,
  runAssignmentSchema,
  runCheckpointReceiptSchema,
  runGitHubCredentialSchema,
  runCommandsResponse,
  daemonVersionsSchema,
  runCompletePath,
  runEventsAccepted,
  type HeartbeatResult,
  type RunCommand,
  type RunCheckpoint,
  type RunCompletion,
  type RunPatch,
} from "@mikka/protocol"

import {
  DaemonError,
  InvalidIdError,
  RunNotPinnedHereError,
  ServerUnreachableError,
} from "./errors"
import { DAEMON_VERSION } from "./paths"
import { createRunMailbox } from './run-mailbox'
import { daemonTracer, routeTemplate } from "./tracing"
import { runRuntimeTimings } from "./run-runtime-timing"
import type {
  ChunkBatch,
  DeviceInfo,
  FetchCommandsOptions,
  RunAssignment,
  ServerLink,
} from "./server-link"

/** How long a run's liveness check may go unanswered (timeouts, 5xx) before
 * the run is treated as not live. A 90 s run lease bounds it from the server. */
export const LIVENESS_UNREACHABLE_GRACE_MS = 30_000
const deviceSessionRejection = z.object({ error: z.enum(["Unauthorized", "authRequired"]) }).strict()

/**
 * Ids go into the path as one escaped segment each. `.` and `..` survive
 * escaping (and URL parsing treats `%2E%2E` as `..` too), so they are refused.
 */
export function checkId(id: string): string {
  if (id === "" || id === "." || id === "..") {
    throw new InvalidIdError(`Refusing id ${JSON.stringify(id)} in a URL path`)
  }
  return id
}

/** One escaped path segment (the protocol's path builders escape too). */
export function seg(id: string): string {
  return encodeURIComponent(checkId(id))
}

/** The server refused the daemon's session: sign in again. */
export class SessionRejectedError extends DaemonError {
  constructor() {
    super(
      DAEMON_RPC_ERRORS.unauthorized,
      "The server refused this device's session; run `mikka daemon login` again."
    )
  }
}

interface CallOptions<T> {
  initialRepository?: true
  body?: unknown
  schema?: z.ZodType<T>
  /** Endpoint-specific success decoding, including an older empty response. */
  decodeResponse?: (response: Response) => Promise<unknown>
  /** Map 409 to `RunNotPinnedHereError` for this run. */
  claimOf?: string
  /** Default 15 s; long-polls wait longer. */
  timeoutMs?: number
  signal?: AbortSignal
}

// The server may live under a path (https://mikka.example.com/mikka), which
// new URL("/v1/...", base) would drop, so paths are appended to the base.
export function serverUrl(base: string, path: string): URL {
  return new URL(`${base.replace(/\/+$/, "")}${path}`)
}

export class HttpServerLink implements ServerLink {
  private readonly runControls = new Set<ToolApprovalGate>()
  private runControlMode: RunControlMode = 'legacy'

  /** Wake local waiters; the same push drains authoritative stop commands. */
  invalidateRunControls() {
    for (const gate of this.runControls) gate.invalidate()
  }
  /** The daemon reports whether the gateway can push run control to this run. */
  setRunControlMode(mode: RunControlMode) {
    this.runControlMode = mode
    for (const gate of this.runControls) gate.setControlMode(mode)
  }
  async downloadChatFile(assignment: RunAssignment, id: string, signal: AbortSignal) {
    const transfer = await this.call('GET', `/v1/devices/${seg(assignment.deviceId)}/runs/${seg(assignment.runId)}/attachments/${seg(id)}`, { schema: chatFileTransferSchema, signal, timeoutMs: 60000 })
    if ('data' in transfer) return transfer
    const url = new URL(transfer.downloadUrl)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com') || url.username || url.password || url.port) throw Error('Invalid attachment storage origin')
    // The capability is sufficient: never forward the device session to storage.
    const response = await this.taskFetch(assignment.runId, 'storage_transfer', url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) })
    if (!response.ok || !response.body) throw Error('Attachment storage unavailable')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > transfer.size || size > CHAT_FILE_MAX_BYTES) { await reader.cancel(); throw Error('Attachment content mismatch') }; chunks.push(next.value) } } finally { reader.releaseLock() }
    if (size !== transfer.size) throw Error('Attachment content mismatch')
    return chatFileDownloadSchema.parse({ ...transfer, data: Buffer.concat(chunks).toString('base64') })
  }
  /** Run entry and resume both call this before repository/setup execution. */
  async verifyRunPolicy(assignment: RunAssignment, signal: AbortSignal) {
    if (signal.aborted) throw Error('Run policy cancelled')
    const path = `/v1/runs/${seg(assignment.runId)}/policy-snapshot`
    const response = await this.send('GET',`${path}?deviceId=${seg(assignment.deviceId)}`,undefined,this.credential,{signal,timeoutMs:5000})
    // Compatibility for an older, unmanaged server only. A signed/required
    // cached assignment cannot invent its own trust key or silently downgrade.
    if (response.status === 404 && !assignment.policySnapshot && !assignment.policySnapshotRequired) return null
    if (!response.ok) throw Error('Run policy distribution unavailable')
    const context = policyDistributionContextSchema.parse(await response.json())
    if (context.issuer !== policyIssuer(this.baseUrl) || context.deviceId !== assignment.deviceId || context.runId !== assignment.runId || context.revision !== assignment.policyRevision) throw Error('Run policy context changed')
    if (!assignment.policySnapshot) {
      if (context.required || assignment.policySnapshotRequired) throw Error('Signed run policy required')
      return context
    }
    if (!assignment.policy || !assignment.policyRevision) throw Error('Run policy unavailable')
    const expected = {runId:assignment.runId,deviceId:assignment.deviceId,revision:assignment.policyRevision,policy:assignment.policy}
    let snapshot = verifyPolicySnapshot(assignment.policySnapshot,context,expected,{allowExpired:true})
    if (snapshot.payload.expiresAt - Date.now() <= POLICY_SNAPSHOT_REFRESH_MS) {
      const renewed = await this.call('POST',path,{body:{deviceId:assignment.deviceId,snapshot},schema:signedPolicySnapshotSchema,signal,timeoutMs:5000})
      snapshot = verifyPolicySnapshot(renewed,context,expected)
    } else snapshot = verifyPolicySnapshot(snapshot,context,expected)
    assignment.policySnapshot = snapshot
    assignment.policy = snapshot.payload.policy
    Object.freeze(assignment.policy.permissions); Object.freeze(assignment.policy.networkAllow)
    if (assignment.policy.networkCeiling) Object.freeze(assignment.policy.networkCeiling)
    Object.freeze(assignment.policy)
    return context
  }
  /** Asks the server's Decisions API for one run. Never throws; null on any failure. */
  decide: ServerDecide = async (runId, request, signal) => {
    const answer = z.discriminatedUnion('type', [
      z.object({ type: z.literal('predicate'), name: z.string(), probability: z.number() }),
      z.object({ type: z.literal('choice'), name: z.string(), choice: z.string() }),
    ])
    try {
      const { answers } = await this.call('POST', `/v1/runs/${seg(runId)}/decision`, { body: request, schema: z.object({ answers: z.array(answer).nullable() }), signal, timeoutMs: 6000 })
      return answers ? new Map<string, ServerDecisionAnswer>(answers.map(item => [item.name, item])) : null
    } catch { return null }
  }

  async prepareRunToolApproval(assignment: RunAssignment, signal: AbortSignal, check: () => void) {
    if (!assignment.policy || !assignment.policyRevision) throw new Error('Run policy unavailable')
    // The claim and entry policy verification already bind this task to its
    // owner and device. Operation-time checks use the held local lease only.
    // Server revocations arrive through the existing commands push/heartbeat,
    // whose stop command revokes this gate and terminates the CLI group.
    const gate = new ToolApprovalGate(assignment.runId, {
      isLive: () => {
        if (signal.aborted) return false
        try { check(); return true } catch { return false }
      },
    }, this.runControlMode)
    this.runControls.add(gate)
    const abort = () => gate.revoke()
    gate.onRevoke(() => { this.runControls.delete(gate); signal.removeEventListener('abort', abort) })
    if (signal.aborted) gate.revoke()
    else signal.addEventListener('abort', abort, { once: true })
    return gate
  }
  async prepareRunMailbox(assignment: RunAssignment, signal: AbortSignal, check: () => void) {
    return createRunMailbox({ assignment, signal, check, endpoint: serverUrl(this.baseUrl, '/api/mcp'), fetch: (url, init) => this.taskFetch(assignment.runId, 'mailbox_operation', url, init),
      headers: { [CLIENT_VERSION_HEADER]: this.clientVersion, ...(this.protectionBypass ? { 'x-vercel-protection-bypass': this.protectionBypass } : {}) } })
  }
  async claimCoordinator(deviceId: string, signal: AbortSignal) {
    const response = await this.send("POST",`/v1/devices/${seg(deviceId)}/coordinator`,{ operation: "claim" },this.credential,{ signal })
    if (response.status === 404) return null // Optional rollout / older server.
    if (response.status === 401) throw new SessionRejectedError()
    if (!response.ok) throw new ServerUnreachableError(response.status)
    return nativeCoordinatorClaimSchema.parse(await response.json()).job
  }

  async coordinatorCommand(deviceId: string, turnId: string, command: NativeCoordinatorCommand, signal: AbortSignal): Promise<void> {
    await this.call("POST",`/v1/devices/${seg(deviceId)}/coordinator`,{ body: { operation: "submit",turnId,command },signal })
  }

  async coordinatorToolResult(deviceId: string, turnId: string, callId: string, signal: AbortSignal) {
    return this.call("POST",`/v1/devices/${seg(deviceId)}/coordinator`,{ body: { operation: "result",turnId,callId },signal,schema: nativeCoordinatorToolResultSchema })
  }

  /** Device session, set by `registerDevice`. */
  private credential: string | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clientVersion: string = DAEMON_VERSION,
    private readonly protectionBypass?: string
  ) {
    if (protectionBypass) {
      const url = new URL(baseUrl)
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app') || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{20,256}$/.test(protectionBypass)) throw new Error('Invalid preview transport')
    }
  }

  /** Count raw task transports too; preserve their existing redirects, body,
   * headers and response streaming without introducing a request. */
  private async taskFetch(runId: string, endpoint: "mailbox_operation" | "storage_transfer" | "task_data", input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const measured = runRuntimeTimings.taskRequest(runId, endpoint, init?.method ?? "GET")
    let status: number | undefined
    try {
      const response = await this.fetchImpl(input, init)
      status = response.status
      return response
    } finally { measured(status) }
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
    {
      timeoutMs = 15_000,
      signal, initialRepository,
    }: { timeoutMs?: number; signal?: AbortSignal; initialRepository?: true } = {}
  ): Promise<Response> {
    const route = routeTemplate(path)
    return daemonTracer.span(`${method} ${route}`, { "mikka.route": route, "url.path": route, "http.request.method": method }, async span => {
      const response = await this.sendTraced(method, path, body, token, { timeoutMs, signal, initialRepository })
      span.set("http.response.status_code", response.status)
      if (response.status >= 400) span.set("mikka.outcome", `http_${response.status}`)
      return response
    })
  }

  private async sendTraced(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
    { timeoutMs, signal, initialRepository }: { timeoutMs: number; signal?: AbortSignal; initialRepository?: true },
  ): Promise<Response> {
    const measured = runRuntimeTimings.request(method, path, body)
    let status: number | undefined
    try {
      const response = await this.fetchImpl(serverUrl(this.baseUrl, path), {
        method,
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          [CLIENT_VERSION_HEADER]: this.clientVersion,
          [POLICY_SNAPSHOT_HEADER]: POLICY_SNAPSHOT_VERSION,
          [SKILL_ARTIFACT_HEADER]: '1',
          [TEAM_SKILL_HEADER]: '1',
          [REPO_ORIGIN_HEADER]: '1',
          [PROJECT_ENVIRONMENT_HEADER]: '1',
          [RECOVERY_WORKTREE_HEADER]: '1',
          [MODEL_CREDENTIAL_HEADER]: '1',
          [TASK_SECRETS_HEADER]: TASK_SECRETS_VERSION,
          [RUN_CREDENTIALS_HEADER]: '1',
          [TASK_MCP_HEADER]: TASK_MCP_VERSION,
          ...(initialRepository ? { [INITIAL_REPOSITORY_HEADER]: '1' } : {}),
          [SUBSCRIPTION_MODEL_CATALOGUE_HEADER]: '1',
          [MAILBOX_NOTICE_HEADER]: '1',
          [WORKSPACE_REQUEST_HEADER]: '1',
          [WORKSPACE_DIFF_REQUEST_HEADER]: '1',
          ...daemonTracer.headers(),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(this.protectionBypass ? { 'x-vercel-protection-bypass': this.protectionBypass } : {}),
        },
        ...(this.protectionBypass ? { redirect: 'error' as const } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      // Deployment protection is not device-session rejection; never follow it with credentials.
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new Error(`Unexpected server redirect (${response.status})`)
      if (response.status === 401) {
        // Only the device API's exact rejection contracts can revoke a saved credential.
        const body: unknown = await response.clone().json().catch(() => null)
        if (!deviceSessionRejection.safeParse(body).success)
          throw new Error("Unexpected device authentication response")
      }
      return response
    } catch (error) {
      throw new ServerUnreachableError(error)
    } finally {
      measured(status)
    }
  }

  private async call<T = undefined>(
    method: string,
    path: string,
    options: CallOptions<T> = {}
  ): Promise<T> {
    const response = await this.send(
      method,
      path,
      options.body,
      this.credential,
      { timeoutMs: options.timeoutMs, signal: options.signal, initialRepository: options.initialRepository }
    )
    if (response.status >= 500 || response.status === 429)
      throw new ServerUnreachableError(response.status)
    if (response.status === 401) throw new SessionRejectedError()
    if (response.status === 409 && options.claimOf) {
      const body = await response.json().catch(() => null) as { code?: unknown; daemonVersions?: unknown } | null
      const upgradeRequired = body?.code === 'daemonUpgradeRequired'
      throw new RunNotPinnedHereError(options.claimOf, upgradeRequired, upgradeRequired ? daemonVersionsSchema.safeParse(body?.daemonVersions).data?.latest : undefined)
    }
    if (!response.ok) {
      const detail = await response
        .json()
        .then((b: unknown) =>
          typeof b === "object" && b !== null && "error" in b
            ? String((b as { error: unknown }).error)
            : undefined
        )
        .catch(() => undefined)
      throw new DaemonError(
        response.status,
        `${method} ${path} failed: ${response.status}${detail ? ` (${detail})` : ""}`,
        { status: response.status, error: detail }
      )
    }
    if (!options.schema) return undefined as T
    const parsed = options.schema.safeParse(options.decodeResponse ? await options.decodeResponse(response) : await response.json())
    if (!parsed.success) {
      throw new DaemonError(
        DAEMON_RPC_ERRORS.serverUnreachable,
        `${method} ${path}: unexpected response from the server`,
        parsed.error.issues
      )
    }
    return parsed.data
  }

  async registerDevice(
    credential: string,
    info: DeviceInfo,
    knownDeviceId?: string
  ) {
    this.credential = credential
    const { deviceId, tracing } = await this.call("POST", devicePaths.register(), {
      body: { ...info, ...(knownDeviceId ? { deviceId: knownDeviceId } : {}) },
      schema: deviceRegistered,
    })
    return { deviceId, tracing }
  }

  async heartbeat(
    deviceId: string,
    status: Parameters<ServerLink["heartbeat"]>[1]
  ): Promise<HeartbeatResult> {
    return this.call("POST", devicePaths.heartbeat(checkId(deviceId)), {
      body: status,
      schema: heartbeatResultSchema,
    })
  }

  async listRepos(deviceId: string) {
    const { repos } = await this.call(
      "GET",
      devicePaths.repos(checkId(deviceId)),
      { schema: deviceReposResponse }
    )
    return repos
  }

  async pendingRuns(deviceId: string) {
    const { runIds } = await this.call(
      "GET",
      devicePaths.pendingRuns(checkId(deviceId)),
      { schema: pendingRunsResponse }
    )
    return runIds
  }

  async claimRun(deviceId: string, runId: string, signal?: AbortSignal, options?: { initialRepository: true }): Promise<RunAssignment> {
    return this.call(
      "POST",
      devicePaths.claim(checkId(deviceId), checkId(runId)),
      { schema: runAssignmentSchema, claimOf: runId, signal, initialRepository: options?.initialRepository }
    )
  }
  async validateSkillReceipt(runId:string,receiptId:string) {
    return this.call('GET',`/v1/runs/${seg(runId)}/skill-receipt?receiptId=${encodeURIComponent(checkId(receiptId))}`,{schema:skillReceiptRevalidationSchema})
  }
  async syncComputerReviews(deviceId: string, requests: LocalComputerRequest[], signal?: AbortSignal) {
    const result = await this.call("POST", computerSyncPath(checkId(deviceId)), { body: { requests }, schema: computerSyncResponse, signal })
    return result.decisions
  }
  async localComputerAuthority(deviceId: string, runId: string) {
    return this.call('GET', `${devicePaths.claim(checkId(deviceId), checkId(runId)).replace(/\/claim$/, '')}/computer-authority`, {
      schema: runAssignmentSchema.shape.localComputer.unwrap(),
    })
  }
  async nativeContext(deviceId:string,runId:string,signal?:AbortSignal,requireModelCatalogue?:boolean) {
    return this.call('POST', `${devicePaths.claim(checkId(deviceId),checkId(runId)).replace(/\/claim$/, '')}/subscription`, {body:{action:'context',...(requireModelCatalogue ? {requireModelCatalogue:true} : {})},schema:nativeBrokerContextSchema,signal})
  }
  async nativeLease(deviceId:string,runId:string,signal?:AbortSignal) {
    return this.call('POST', `${devicePaths.claim(checkId(deviceId),checkId(runId)).replace(/\/claim$/, '')}/subscription-lease`, {schema:nativeLeaseSchema,signal})
  }
  async githubLease(deviceId: string, runId: string, signal?: AbortSignal) {
    return this.call('POST', `/v1/devices/${seg(deviceId)}/github-token?runId=${seg(runId)}`, {
      schema: runGitHubCredentialSchema, signal,
    })
  }

  async nativeRequest(deviceId:string,runId:string,payload:NativeBrokerRequest,signal?:AbortSignal) {
    const response=await this.send('POST',`${devicePaths.claim(checkId(deviceId),checkId(runId)).replace(/\/claim$/, '')}/subscription`,{action:'request',payload},this.credential,{signal,timeoutMs:275_000})
    const contentType=response.headers.get('content-type')?.split(';')[0]
    if(!response.ok || !response.body || (contentType!=='text/event-stream' && contentType!=='application/json')) {
      await response.body?.cancel()
      throw new Error('subscription_native_unavailable')
    }
    return {contentType,body:response.body}
  }

  async beginCapture(runId: string, request: CaptureUploadRequest) {
    return this.call("POST", capturePaths.begin(checkId(runId)), { body: request, schema: captureUploadResponse })
  }

  async resumeCapture(runId: string, captureId: string) {
    return this.call("POST", capturePaths.upload(checkId(runId), checkId(captureId)), { schema: captureUploadResponse })
  }

  /** Straight to object storage with the signed headers, or to the server when it has no bucket. */
  async sendCapture(runId: string, captureId: string, upload: CaptureUploadResponse["upload"], bytes: Uint8Array, contentType: string) {
    const server = upload.target === "server"
    let response: Response
    try {
      response = await this.taskFetch(runId, server ? "task_data" : "storage_transfer", server ? serverUrl(this.baseUrl, capturePaths.upload(checkId(runId), checkId(captureId))) : upload.url, {
        method: "PUT",
        headers: server
          ? { "content-type": contentType, [CLIENT_VERSION_HEADER]: this.clientVersion, ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}), ...(this.protectionBypass ? { 'x-vercel-protection-bypass': this.protectionBypass } : {}) }
          : upload.headers,
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(300_000),
      })
    } catch (error) {
      throw new ServerUnreachableError(error)
    }
    if (response.status >= 500 || response.status === 429) throw new ServerUnreachableError(response.status)
    if (response.status === 401 && server) throw new SessionRejectedError()
    if (!response.ok) throw new DaemonError(response.status, `PUT capture failed: ${response.status}`, { status: response.status })
  }

  async completeCapture(runId: string, captureId: string) {
    const { capture } = await this.call("POST", capturePaths.complete(checkId(runId), checkId(captureId)), { schema: captureCompleteResponse, timeoutMs: 120_000 })
    return capture
  }

  async screenCapture(runId: string, request: ScreenCaptureRequest, signal?: AbortSignal) {
    return this.call("POST", capturePaths.screen(checkId(runId)), { body: request, schema: screenCaptureResponse, signal, timeoutMs: 120_000 })
  }

  async appendRunChunks(runId: string, batch: ChunkBatch) {
    return this.call("POST", devicePaths.runEvents(checkId(runId)), {
      body: batch,
      schema: runEventsAccepted,
    })
  }

  async checkpointRun(runId: string, checkpoint: RunCheckpoint) {
    return this.call("POST", devicePaths.runCheckpoint(checkId(runId)), {
      body: checkpoint,
      schema: runCheckpointReceiptSchema.refine(receipt => receipt.runId === runId, { message: 'Checkpoint receipt belongs to another run' }).optional(),
      decodeResponse: async response => response.status === 204 ? undefined : response.json().catch(() => null),
    })
  }

  async updateRun(runId: string, patch: RunPatch) {
    await this.call("PATCH", devicePaths.runPatch(checkId(runId)), {
      body: patch,
    })
  }

  async deviceGateway(deviceId: string, signal?: AbortSignal) {
    return this.call("GET", devicePaths.gateway(checkId(deviceId)), {
      schema: deviceGatewaySchema,
      signal,
      timeoutMs: 10_000,
    })
  }

  async fetchCommands(
    deviceId: string,
    waitSeconds: number,
    {
      signal,
      skipRuns = [],
      onQueuedRuns,
      updates,
      onUpdates,
      workspaceSkip = [],
      onWorkspaceRequests,
    }: FetchCommandsOptions = {}
  ): Promise<RunCommand[]> {
    const response = await this.call(
      "GET",
      devicePaths.commands(
        checkId(deviceId),
        waitSeconds,
        skipRuns.map(checkId),
        updates && { daemonLatest: updates.daemonLatest, skipDeviceCommands: updates.skipDeviceCommands?.map(checkId) }
      ) + (workspaceSkip.length ? `&skipWorkspaceRequests=${workspaceSkip.map(checkId).join(',')}` : ''),
      {
        schema: runCommandsResponse,
        timeoutMs: (waitSeconds + 15) * 1000,
        signal,
      }
    )
    if (response.queuedRuns?.length) onQueuedRuns?.(response.queuedRuns)
    if (response.workspaceRequests?.length) onWorkspaceRequests?.(response.workspaceRequests)
    if (response.daemonVersions || response.deviceCommands?.length) onUpdates?.({ daemonVersions: response.daemonVersions, deviceCommands: response.deviceCommands ?? [] })
    return response.commands
  }

  async answerWorkspaceRead(deviceId: string, requestId: string, receipt: WorkspaceReadReceipt, options: { expiresAt: string; signal?: AbortSignal }) {
    // One bounded delivery operation: a transient 5xx/network error cannot
    // strand a request while the push socket stays open. Keep source only in
    // memory, retry at most twice, and stop at the original request deadline.
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = Date.parse(options.expiresAt) - Date.now()
      options.signal?.throwIfAborted()
      if (remaining <= 0) throw new ServerUnreachableError('Workspace receipt expired')
      try {
        await this.call('POST', `/v1/devices/${checkId(deviceId)}/workspace/requests/${checkId(requestId)}`, {
          body: receipt, signal: options.signal, timeoutMs: Math.min(4000, remaining),
        })
        return
      } catch (error) {
        if (!(error instanceof ServerUnreachableError) || error.cause === 429 || attempt === 2) throw error
      }
    }
  }

  async ackCommands(deviceId: string, delivered: string[]) {
    if (delivered.length === 0) return
    await this.call("POST", devicePaths.commandsAck(checkId(deviceId)), {
      body: { delivered },
    })
  }

  async fetchFsRequests(
    deviceId: string,
    waitSeconds: number,
    { signal }: { signal?: AbortSignal } = {}
  ) {
    const response = await this.call(
      "GET",
      fsPaths.requests(checkId(deviceId), waitSeconds),
      {
        schema: fsRequestsResponse,
        timeoutMs: (waitSeconds + 15) * 1000,
        signal,
      }
    )
    return response.requests
  }

  async answerFsRequest(deviceId: string, requestId: string, result: FsResult) {
    await this.call(
      "POST",
      fsPaths.respond(checkId(deviceId), checkId(requestId)),
      { body: result }
    )
  }

  async completeRun(runId: string, completion: RunCompletion) {
    await this.call("POST", runCompletePath(checkId(runId)), {
      body: completion,
    })
  }
}
