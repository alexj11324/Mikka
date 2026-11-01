import { nativeCoordinatorClaimSchema, nativeCoordinatorToolResultSchema, type NativeCoordinatorCommand } from "@mikka/protocol/coordinator"
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
import { ToolApprovalGate } from "./agents/tool-approval"
import { POLICY_SNAPSHOT_HEADER, POLICY_SNAPSHOT_VERSION, POLICY_SNAPSHOT_REFRESH_MS, policyDistributionContextSchema, policyIssuer, signedPolicySnapshotSchema } from '@mikka/protocol/policy-snapshot'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { toolApprovalDecision } from "./agents/tool-approval-policy"
import { judgeNetworkDestination, noServerDecision } from "./decision-judgments"
import type { ServerDecide } from "./server-decision"
import { runApps } from "./agents/run-apps"
import { SKILL_ARTIFACT_HEADER, TEAM_SKILL_HEADER, skillReceiptRevalidationSchema } from '@mikka/protocol/skill'
import { nativeBrokerContextSchema, nativeLeaseSchema, type NativeBrokerRequest } from '@mikka/protocol/subscription'
import { computerSyncPath, computerSyncResponse, type LocalComputerRequest } from '@mikka/protocol/computer'
import { captureCompleteResponse, capturePaths, captureUploadResponse, screenCaptureResponse, type CaptureUploadRequest, type CaptureUploadResponse, type ScreenCaptureRequest } from '@mikka/protocol/capture'

import {
  CLIENT_VERSION_HEADER,
  REPO_ORIGIN_HEADER,
  RECOVERY_WORKTREE_HEADER,
  MODEL_CREDENTIAL_HEADER,
  DAEMON_RPC_ERRORS,
  devicePaths,
  fsPaths,
  fsRequestsResponse,
  type FsResult,
  deviceRegistered,
  deviceReposResponse,
  heartbeatResultSchema,
  pendingRunsResponse,
  runAssignmentSchema,
  runCommandsResponse,
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
import type {
  ChunkBatch,
  DeviceInfo,
  RunAssignment,
  ServerLink,
} from "./server-link"

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
  body?: unknown
  schema?: z.ZodType<T>
  /** Map 409 to `RunNotPinnedHereError` for this run. */
  claimOf?: string
  /** Default 15 s; long-polls wait longer. */
  timeoutMs?: number
  signal?: AbortSignal
}

// The server may live under a path (https://app.aspectlylabs.com/mikka), which
// new URL("/v1/...", base) would drop, so paths are appended to the base.
export function serverUrl(base: string, path: string): URL {
  return new URL(`${base.replace(/\/+$/, "")}${path}`)
}

export class HttpServerLink implements ServerLink {
  /** The run-scoped Decisions API once this class provides `decide`; until then no answer. */
  private serverDecide(): ServerDecide {
    const own = (this as Partial<{ decide: ServerDecide }>).decide
    return own ? own.bind(this) : noServerDecision
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
  async prepareRunToolApproval(assignment: RunAssignment, signal: AbortSignal, check: () => void, worktree?: string) {
    if (!assignment.policy || !assignment.policyRevision) throw new Error('Run policy unavailable')
    let context = signal.aborted ? null : await this.verifyRunPolicy(assignment,signal)
    const policyRevision = assignment.policyRevision
    const path = `/v1/runs/${seg(assignment.runId)}/tool-approval`
    const proposal = z.object({ id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), status: z.string() })
    const response = z.object({ decision: z.enum(['pending', 'allow', 'deny']) })
    const liveness = new AbortController()
    const gate = new ToolApprovalGate(assignment.runId, {
      permission: request => toolApprovalDecision(request, assignment.policy, worktree, runApps(assignment.mcp)?.apps.map(app => app.name),
        assignment.github ? [new URL(assignment.github.endpoint).host] : []),
      preauthorizeNetwork: (request, signal) => {
        const { host, port } = request.input as { host: string; port: number }
        return judgeNetworkDestination(this.serverDecide(), assignment.runId, {
          host, port, repo: assignment.expectedRepoRemote ?? assignment.repoId,
          task: assignment.prompt, allow: assignment.policy?.networkAllow ?? [],
        }, signal)
      },
      // Keep the callback pending at the tool boundary. The adapter's current
      // session and checkpoint remain intact; handback resolves this same call.
      isLive: async () => {
        try {
          for (;;) {
            check()
            if (assignment.policySnapshot) {
              if (!context) return false
              if (assignment.policySnapshot.payload.expiresAt - Date.now() <= POLICY_SNAPSHOT_REFRESH_MS) context = await this.verifyRunPolicy(assignment,liveness.signal)
              if (!context) return false
              verifyPolicySnapshot(assignment.policySnapshot,context,{runId:assignment.runId,deviceId:assignment.deviceId,revision:policyRevision,policy:assignment.policy})
            }
            const current = await this.call('POST', path, { body: { operation: 'check', deviceId: assignment.deviceId, policyRevision }, schema: z.object({ live: z.boolean(), paused: z.boolean().optional() }), signal:liveness.signal, timeoutMs:5000 })
            check()
            if (!current.live || !current.paused) return current.live
            await new Promise<void>((resolve, reject) => {
              const stop = () => { clearTimeout(timer); reject(new Error('cancelled')) }
              const timer = setTimeout(() => { liveness.signal.removeEventListener('abort',stop); resolve() },1000)
              liveness.signal.addEventListener('abort',stop,{once:true})
              if (liveness.signal.aborted) stop()
            })
          }
        } catch { return false }
      },
      ask: async (request, signal) => {
        const delay = () => new Promise<void>((resolve, reject) => {
          const done = () => { signal.removeEventListener('abort', stop); resolve() }
          const timer = setTimeout(done, 1000)
          const stop = () => { clearTimeout(timer); reject(new Error('cancelled')) }
          signal.addEventListener('abort', stop, { once: true })
          if (signal.aborted) stop()
        })
        const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
          for (;;) {
            try { return await operation() }
            catch (error) { if (signal.aborted || !(error instanceof ServerUnreachableError)) throw error; await delay() }
          }
        }
        if (!await gate.checkLive()) return 'deny'
        const created = await retry(() => this.call('POST', path, { body: { operation: 'propose', deviceId: assignment.deviceId, policyRevision, requestId: request.requestId, harness: request.harness, method: request.method, input: request.input }, schema: proposal, signal }))
        try {
          for (;;) {
            if (!await gate.checkLive()) return 'deny'
            const result = await retry(() => this.call('POST', path, { body: { operation: 'take', deviceId: assignment.deviceId, id: created.id, digest: created.digest }, schema: response, signal }))
            if (result.decision !== 'pending') return result.decision
            await delay()
          }
        } finally {
          void this.call('POST', path, { body: { operation: 'cancel', deviceId: assignment.deviceId, id: created.id, digest: created.digest } }).catch(() => undefined)
        }
      },
    })
    let checking = false
    const monitor = setInterval(() => {
      if (checking || gate.revoked) return
      checking = true
      void gate.checkLive().then(live => { if (!live) gate.revoke() }).finally(() => { checking = false })
    },1000)
    monitor.unref()
    const abort = () => gate.revoke()
    gate.onRevoke(() => { liveness.abort(); clearInterval(monitor); signal.removeEventListener('abort',abort) })
    if (signal.aborted) gate.revoke()
    else signal.addEventListener('abort', abort, { once: true })
    return gate
  }
  async prepareRunMailbox(assignment: RunAssignment, signal: AbortSignal, check: () => void) {
    return createRunMailbox({ assignment, signal, check, endpoint: serverUrl(this.baseUrl, '/api/mcp'), fetch: this.fetchImpl,
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

  private async send(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
    {
      timeoutMs = 15_000,
      signal,
    }: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<Response> {
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
          [RECOVERY_WORKTREE_HEADER]: '1',
          [MODEL_CREDENTIAL_HEADER]: '1',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(this.protectionBypass ? { 'x-vercel-protection-bypass': this.protectionBypass } : {}),
        },
        ...(this.protectionBypass ? { redirect: 'error' as const } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
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
      { timeoutMs: options.timeoutMs, signal: options.signal }
    )
    if (response.status >= 500 || response.status === 429)
      throw new ServerUnreachableError(response.status)
    if (response.status === 401) throw new SessionRejectedError()
    if (response.status === 409 && options.claimOf)
      throw new RunNotPinnedHereError(options.claimOf)
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
    const parsed = options.schema.safeParse(await response.json())
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
    const { deviceId } = await this.call("POST", devicePaths.register(), {
      body: { ...info, ...(knownDeviceId ? { deviceId: knownDeviceId } : {}) },
      schema: deviceRegistered,
    })
    return { deviceId }
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

  async claimRun(deviceId: string, runId: string): Promise<RunAssignment> {
    return this.call(
      "POST",
      devicePaths.claim(checkId(deviceId), checkId(runId)),
      { schema: runAssignmentSchema, claimOf: runId }
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
  async nativeContext(deviceId:string,runId:string,signal?:AbortSignal) {
    return this.call('POST', `${devicePaths.claim(checkId(deviceId),checkId(runId)).replace(/\/claim$/, '')}/subscription`, {body:{action:'context'},schema:nativeBrokerContextSchema,signal})
  }
  async nativeLease(deviceId:string,runId:string,signal?:AbortSignal) {
    return this.call('POST', `${devicePaths.claim(checkId(deviceId),checkId(runId)).replace(/\/claim$/, '')}/subscription-lease`, {schema:nativeLeaseSchema,signal})
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
      response = await this.fetchImpl(server ? serverUrl(this.baseUrl, capturePaths.upload(checkId(runId), checkId(captureId))) : upload.url, {
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
    await this.call("POST", devicePaths.runCheckpoint(checkId(runId)), {
      body: checkpoint,
    })
  }

  async updateRun(runId: string, patch: RunPatch) {
    await this.call("PATCH", devicePaths.runPatch(checkId(runId)), {
      body: patch,
    })
  }

  async fetchCommands(
    deviceId: string,
    waitSeconds: number,
    {
      signal,
      skipRuns = [],
    }: { signal?: AbortSignal; skipRuns?: readonly string[] } = {}
  ): Promise<RunCommand[]> {
    const response = await this.call(
      "GET",
      devicePaths.commands(
        checkId(deviceId),
        waitSeconds,
        skipRuns.map(checkId)
      ),
      {
        schema: runCommandsResponse,
        timeoutMs: (waitSeconds + 15) * 1000,
        signal,
      }
    )
    return response.commands
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
