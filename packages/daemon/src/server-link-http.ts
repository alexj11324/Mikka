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
import { SKILL_ARTIFACT_HEADER, skillReceiptRevalidationSchema } from '@mikka/protocol/skill'

import {
  CLIENT_VERSION_HEADER,
  REPO_ORIGIN_HEADER,
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
    private readonly clientVersion: string = DAEMON_VERSION
  ) {}

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
          [SKILL_ARTIFACT_HEADER]: '1',
          [REPO_ORIGIN_HEADER]: '1',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
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
