// HttpServerLink and `mikka daemon login` against a scripted fetch: paths,
// headers, credentials (the device session everywhere), status handling and response
// decoding with the packages/protocol schemas.
import { afterEach, describe, expect, it, vi } from "vitest"

import { CLIENT_VERSION_HEADER, RUN_CREDENTIALS_HEADER, SUBSCRIPTION_MODEL_CATALOGUE_HEADER, emptyRunReport } from "@mikka/protocol"
import { defaultRunPolicy } from "@mikka/protocol/agent-policy"
import { TEAM_SKILL_HEADER } from '@mikka/protocol/skill'
import { RECOVERY_WORKTREE_HEADER } from "@mikka/protocol/device"
import { TASK_SECRETS_HEADER, TASK_SECRETS_VERSION } from '@mikka/protocol/task-secrets'

import {
  DaemonError,
  RunNotPinnedHereError,
  ServerUnreachableError,
} from "../src/errors"
import { deviceLogin, LoginError } from "../src/login"
import { HttpServerLink, SessionRejectedError } from "../src/server-link-http"
import { Daemon } from "../src/main"
import { readJson, writeJsonAtomic } from "../src/fs-util"
import { createLogger } from "../src/log"
import { DAEMON_VERSION } from "../src/paths"
import { cleanupTempDirs, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

interface Call {
  method: string
  path: string
  auth: string | null
  version: string | null
  body: unknown
  redirect: RequestInit["redirect"]
}

function scripted(respond: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = (async (url: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname + new URL(String(url)).search,
      auth: headers.get("authorization"),
      version: headers.get(CLIENT_VERSION_HEADER),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      redirect: init?.redirect,
    }
    if (call.path.includes("/policy-snapshot?")) return new Response(null,{status:404})
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { fetch: impl, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

// Safe shape captured from the deployment-protection response; no credentials or access links.
const PROTECTION_401 = {
  access: "protected", error: { message: "Protected deployment", code: "401" },
  mcp: {}, message: "Protected deployment", protection: {},
}

const INFO = {
  name: "mac",
  platform: "darwin",
  arch: "arm64",
  daemonVersion: "0.0.1",
  protocolVersion: 1,
  harnesses: [],
}
const SOON = () => new Date(Date.now() + 10 * 60_000).toISOString()

const assignment = (runId: string) => ({
  runId,
  issueId: "issue-1",
  deviceId: "dev-1",
  repoId: "repo-1",
  baseBranch: "main",
  harness: "mock",
  prompt: "Do it",
  leaseExpiresAt: SOON(),
})

describe("HttpServerLink", () => {
  it.each(['begin', 'resume', 'send', 'complete'] as const)('cancels the capture %s transport with the final flush deadline', async stage => {
    let entered!: () => void, release!: (response: Response) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let transportSignal: AbortSignal | null | undefined
    const fetcher: typeof fetch = async (_url, init) => {
      transportSignal = init?.signal
      entered()
      return new Promise<Response>((resolve, reject) => {
        release = resolve
        transportSignal?.addEventListener('abort', () => reject(transportSignal!.reason), { once: true })
      })
    }
    const link = new HttpServerLink('http://server.test', fetcher), deadline = new AbortController()
    const captureId = '00000000-0000-4000-8000-000000000001'
    const operation = stage === 'begin'
      ? link.beginCapture('run-1', { captureId, title: 'Evidence', contentType: 'image/png', size: 1, sha256: 'a'.repeat(64) }, deadline.signal)
      : stage === 'resume' ? link.resumeCapture('run-1', captureId, deadline.signal)
        : stage === 'send' ? link.sendCapture('run-1', captureId, { target: 'server' }, new Uint8Array([0]), 'image/png', deadline.signal)
          : link.completeCapture('run-1', captureId, deadline.signal)
    const result = operation.then(() => undefined, error => error)
    try {
      await started
      deadline.abort(new Error('Capture finalization deadline exceeded'))
      expect(transportSignal?.aborted).toBe(true)
      expect(await result).toBeInstanceOf(ServerUnreachableError)
    } finally { release(new Response(null, { status: 204 })); await result }
  })

  it('returns the authoritative checkpoint receipt through the authenticated upload', async () => {
    const checkpoint = { baseCommit: 'a'.repeat(40), patch: 'H4sIAAAAAAAAAwMAAAAAAAAAAAA=', files: 0, takenAt: '2099-01-01T00:00:00.000Z' }
    const receipt = { runId: 'run-1', takenAt: '2026-01-02T03:04:05.678Z' }
    const { fetch, calls } = scripted(call => call.path.endsWith('/register')
      ? json({ deviceId: 'dev-1', workspaceId: crypto.randomUUID() }, 201)
      : json(receipt))
    const link = new HttpServerLink('http://server.test', fetch)
    await link.registerDevice('fixture-checkpoint-device', INFO)
    expect(await link.checkpointRun('run-1', checkpoint)).toEqual(receipt)
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/v1/runs/run-1/checkpoint',
      auth: 'Bearer fixture-checkpoint-device', body: checkpoint })
    expect(checkpoint.takenAt).toBe('2099-01-01T00:00:00.000Z')
  })

  it('keeps a legacy checkpoint 204 compatible without inventing a snapshot receipt', async () => {
    const checkpoint = { baseCommit: 'a'.repeat(40), patch: '', files: 0, takenAt: '2099-01-01T00:00:00.000Z' }
    const { fetch, calls } = scripted(() => new Response(null, { status: 204 }))
    expect(await new HttpServerLink('http://server.test', fetch).checkpointRun('run-1', checkpoint)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['another run', { runId: 'other-run', takenAt: '2026-01-02T03:04:05.678Z' }],
    ['missing server time', { runId: 'run-1' }],
    ['invalid server time', { runId: 'run-1', takenAt: 'not-a-time' }],
    ['noncanonical server time', { runId: 'run-1', takenAt: '2026-01-02T03:04:05.678+00:00' }],
    ['unknown fields', { runId: 'run-1', takenAt: '2026-01-02T03:04:05.678Z', unverified: true }],
  ] as const)('rejects a checkpoint response with %s', async (_reason, receipt) => {
    const checkpoint = { baseCommit: 'a'.repeat(40), patch: '', files: 0, takenAt: '2099-01-01T00:00:00.000Z' }
    const { fetch, calls } = scripted(() => json(receipt))
    await expect(new HttpServerLink('http://server.test', fetch).checkpointRun('run-1', checkpoint)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('advertises strict local-worktree continuation and preserves the required assignment', async () => {
    const fetcher = (async (_url, init) => {
      expect(new Headers(init?.headers).get(RECOVERY_WORKTREE_HEADER)).toBe('1')
      expect(new Headers(init?.headers).get(RUN_CREDENTIALS_HEADER)).toBe('1')
      expect(new Headers(init?.headers).get(SUBSCRIPTION_MODEL_CATALOGUE_HEADER)).toBe('1')
      expect(new Headers(init?.headers).get(TEAM_SKILL_HEADER)).toBe('1')
      expect(new Headers(init?.headers).get(TASK_SECRETS_HEADER)).toBe(TASK_SECRETS_VERSION)
      return json({...assignment('run-1'),continuesRunId:'lost-run',requireWorktreeContinuation:true})
    }) as typeof fetch
    const result=await new HttpServerLink('http://server.test',fetcher).claimRun('dev-1','run-1')
    expect(result.requireWorktreeContinuation).toBe(true)
  })
  it('renews task grants through the existing authenticated heartbeat without extra requests', async () => {
    const grant = { name: 'VENDOR_KEY', capability: 'synthetic-opaque-initial', expiresAt: SOON(), origin: 'https://api.example.com' }
    const access = { version: 1, endpoint: 'http://server.test/v1/task-secrets/run-1', grants: [grant], unavailable: ['SIGNING_KEY'] }
    const renewed = { ...access, grants: [{ ...grant, capability: 'synthetic-opaque-renewal' }] }
    const github = { endpoint: 'http://server.test/api/runs/github-token', repository: 'owner/repo', token: 'synthetic-native-github', expiresAt: null }
    const modelCredential = { kind: 'provider', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', key: 'synthetic-native-model' }
    const { fetch, calls } = scripted(call => {
      if (call.path.endsWith('/register')) return json({ deviceId: 'dev-1', workspaceId: crypto.randomUUID() }, 201)
      expect(call.auth).toBe('Bearer fixture-task-device-session')
      if (call.path.endsWith('/claim')) return json({ ...assignment('run-1'), harness: 'codex', taskSecrets: access, github, modelCredential })
      expect(call.path).toBe('/v1/devices/dev-1/heartbeat')
      expect(call.body).toMatchObject({ runs: [{ runId: 'run-1', secretCapabilities: [grant.capability] }] })
      return json({ leases: { 'run-1': grant.expiresAt }, taskSecrets: { 'run-1': renewed } })
    })
    const link = new HttpServerLink('http://server.test', fetch)
    await link.registerDevice('fixture-task-device-session', INFO)
    const claimed = await link.claimRun('dev-1', 'run-1')
    expect(claimed.taskSecrets).toEqual(access)
    expect(claimed.github).toEqual(github)
    expect(claimed.modelCredential).toEqual(modelCredential)
    const result = await link.heartbeat('dev-1', { harnesses: [], worktreeDiskBytes: 0,
      runs: [{ runId: 'run-1', lastProgressAt: new Date().toISOString(), secretCapabilities: claimed.taskSecrets!.grants.map(item => item.capability) }] })
    expect(result.taskSecrets).toEqual({ 'run-1': renewed })
    expect(calls).toHaveLength(3)
  })
  it('preserves negotiated catalogue evidence in the natural-expiry lease response', async () => {
    const lease = { route: 'claude_code_cli', modelId: 'claude-haiku-5-5', accountId: 'fixture-account', revision: 1,
      expiresAt: SOON(), accessToken: 'fixture-access', modelCatalogueVerified: true }
    const fetcher = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(SUBSCRIPTION_MODEL_CATALOGUE_HEADER)).toBe('1')
      return json(lease)
    }) as unknown as typeof fetch
    expect(await new HttpServerLink('http://server.test', fetcher).nativeLease('dev-1', 'run-1')).toEqual(lease)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('uses only the claimed local lease for every provider/tool check', async () => {
    const fetcher = vi.fn(async () => { throw new Error('operation-time HTTP is forbidden') })
    const link = new HttpServerLink('http://server.test', fetcher)
    let live = true
    const check = vi.fn(() => { if (!live) throw new Error('local lease expired') })
    const gate = await link.prepareRunToolApproval({ ...assignment('run-1'), harness: 'codex', policy: defaultRunPolicy(), policyRevision: 'a'.repeat(64) }, new AbortController().signal, check)
    try {
      for (let i = 0; i < 100; i++) expect(await gate.checkLive()).toBe(true)
      live = false
      expect(await gate.checkLive()).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
      expect(check).toHaveBeenCalledTimes(101)
    } finally { gate.revoke() }
  })

  it('revokes a prepared approval gate when its run aborts, including before preparation', async () => {
    const { fetch, calls } = scripted(() => json({ live: true }))
    const link = new HttpServerLink('http://server.test', fetch)
    const run = { ...assignment('run-1'), harness:'codex' as const, policy:defaultRunPolicy(), policyRevision:'a'.repeat(64) }
    const before = new AbortController(); before.abort()
    const alreadyAborted = await link.prepareRunToolApproval(run, before.signal, () => {})
    expect(alreadyAborted.revoked).toBe(true)
    expect(await alreadyAborted.checkLive()).toBe(false)
    const during = new AbortController()
    const gate = await link.prepareRunToolApproval(run, during.signal, () => {})
    during.abort()
    expect(gate.revoked).toBe(true)
    expect(await gate.checkLive()).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('sends a private preview bypass only to the fixed HTTPS preview origin and refuses redirects', async () => {
    const previewSecret = 'fixture-preview-secret-1234567890'
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('https://fixture.vercel.app/mikka/v1/devices/register')
      expect(new Headers(init?.headers).get('x-vercel-protection-bypass')).toBe(previewSecret)
      expect(init?.redirect).toBe('error')
      return json({ deviceId: 'dev-1', workspaceId: crypto.randomUUID() }, 201)
    }
    await new HttpServerLink('https://fixture.vercel.app/mikka', fetcher, '1', previewSecret).registerDevice('session-1', INFO)
    expect(() => new HttpServerLink('https://attacker.example/mikka', fetcher, '1', previewSecret)).toThrow('Invalid preview transport')
    expect(() => new HttpServerLink('http://fixture.vercel.app/mikka', fetcher, '1', previewSecret)).toThrow('Invalid preview transport')
  })
  it("sends exact computer reviews over the authenticated device channel", async () => {
    const id = crypto.randomUUID(), runId = crypto.randomUUID(), digest = 'a'.repeat(64)
    const { fetch, calls } = scripted(call => call.path.endsWith('/register')
      ? json({ deviceId: 'dev-1', workspaceId: crypto.randomUUID() }, 201)
      : json({ decisions: [{ id, digest, approve: true }] }))
    const link = new HttpServerLink('http://server.test', fetch)
    await link.registerDevice('fixture-device-session', INFO)
    const request = { id, runId, target: 'b'.repeat(64), display: ':2', call: { name: 'click' as const, arguments: { x: 3, y: 4 } }, expiresAt: Date.now() + 60000, digest }
    expect(await link.syncComputerReviews('dev-1', [request])).toEqual([{ id, digest, approve: true }])
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/v1/devices/dev-1/computer', auth: 'Bearer fixture-device-session', body: { requests: [request] } })
  })
  it("registers with the session and the client version header", async () => {
    const { fetch, calls } = scripted(() =>
      json({ deviceId: "dev-1", workspaceId: crypto.randomUUID() }, 201)
    )
    const link = new HttpServerLink("http://server.test", fetch, "1.2.3")
    expect(await link.registerDevice("session-1", INFO, "dev-old")).toEqual({
      deviceId: "dev-1",
    })
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/devices/register",
      auth: "Bearer session-1",
      version: "1.2.3",
      body: { ...INFO, deviceId: "dev-old" },
    })
  })

  it("uses the device session for the device's routes and the run's", async () => {
    const { fetch, calls } = scripted((call) => {
      if (call.path.endsWith("/claim")) return json(assignment("run-1"))
      if (call.path.endsWith("/events")) return json({ offset: "3" })
      if (call.path.endsWith("/heartbeat"))
        return json({ leases: { "run-1": SOON() } })
      return new Response(null, { status: 204 })
    })
    const link = new HttpServerLink("http://server.test", fetch)
    await link.registerDevice("session-1", INFO).catch(() => undefined) // 204 has no body to decode; only sets the session
    calls.length = 0
    await link.claimRun("dev-1", "run-1")
    await link.appendRunChunks("run-1", {
      fromSeq: 1,
      chunks: [{ type: "start" }],
    })
    await link.heartbeat("dev-1", {
      harnesses: [],
      runs: [],
      worktreeDiskBytes: 0,
    })
    await link.updateRun("run-1", { state: "running" })
    await link.completeRun("run-1", {
      stopReason: "error",
      report: emptyRunReport(),
    })
    expect(calls.map((c) => [c.method, c.path, c.auth])).toEqual([
      ["POST", "/v1/devices/dev-1/runs/run-1/claim", "Bearer session-1"],
      ["POST", "/v1/runs/run-1/events", "Bearer session-1"],
      ["POST", "/v1/devices/dev-1/heartbeat", "Bearer session-1"],
      ["PATCH", "/v1/runs/run-1", "Bearer session-1"],
      ["POST", "/v1/runs/run-1/complete", "Bearer session-1"],
    ])
  })

  it("asks the commands poll for releases and device commands, and passes on what the server names", async () => {
    const command = { id: "6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20", kind: "update" }
    const answers = [
      { commands: [], daemonVersions: { min: "0.0.299", latest: "0.0.401" }, deviceCommands: [command] },
      { commands: [] }, // an older server
      { commands: [], daemonVersions: { min: "0.0.299", latest: "0.0.401; rm -rf ~" }, deviceCommands: [{ id: "x", kind: "format" }] },
    ]
    const { fetch, calls } = scripted(() => json(answers[calls.length - 1]))
    const link = new HttpServerLink("http://server.test", fetch)
    const updates = vi.fn()
    await link.fetchCommands("d", 25, { updates: { daemonLatest: "0.0.400", skipDeviceCommands: ["c1"] }, onUpdates: updates })
    expect(calls[0]!.path).toBe("/v1/devices/d/commands?wait=25&daemonLatest=0.0.400&skipDeviceCommands=c1")
    expect(updates).toHaveBeenCalledExactlyOnceWith({ daemonVersions: { min: "0.0.299", latest: "0.0.401" }, deviceCommands: [command] })
    await expect(link.fetchCommands("d", 25, { updates: { daemonLatest: "0.0.400" }, onUpdates: updates })).resolves.toEqual([])
    expect(calls[1]!.path).toBe("/v1/devices/d/commands?wait=25&daemonLatest=0.0.400")
    await expect(link.fetchCommands("d", 25, { onUpdates: updates })).resolves.toEqual([])
    expect(updates).toHaveBeenCalledOnce() // nothing named, or nothing valid: no call, no failure
  })

  it("passes on the release a server names when it refuses a claim from a daemon too old", async () => {
    const { fetch } = scripted(() => json({ error: "x", code: "daemonUpgradeRequired", daemonVersions: { min: "0.0.299", latest: "0.0.401" } }, 409))
    const error = await new HttpServerLink("http://server.test", fetch).claimRun("d", "r").catch((e: unknown) => e)
    expect((error as RunNotPinnedHereError).latest).toBe("0.0.401")
  })

  it("marks a claim refused because the daemon is too old", async () => {
    for (const [body, upgradeRequired] of [[{ error: "x", code: "daemonUpgradeRequired" }, true], [{ error: "Run is not queued for this device." }, false]] as const) {
      const { fetch } = scripted(() => json(body, 409))
      const error = await new HttpServerLink("http://server.test", fetch).claimRun("d", "r").catch((e: unknown) => e)
      expect(error).toBeInstanceOf(RunNotPinnedHereError)
      expect((error as RunNotPinnedHereError).upgradeRequired).toBe(upgradeRequired)
    }
  })

  it("maps statuses: 5xx/429/network retry later, 409 on claim, 401 needs login", async () => {
    const statuses = [503, 429, 409, 401, 400]
    let i = 0
    const { fetch } = scripted(() => {
      const status = statuses[i++]!
      return json({ error: status === 401 ? "Unauthorized" : "x" }, status)
    })
    const link = new HttpServerLink("http://server.test", fetch)
    await expect(link.pendingRuns("d")).rejects.toBeInstanceOf(
      ServerUnreachableError
    )
    await expect(link.pendingRuns("d")).rejects.toBeInstanceOf(
      ServerUnreachableError
    )
    await expect(link.claimRun("d", "r")).rejects.toBeInstanceOf(
      RunNotPinnedHereError
    )
    await expect(link.pendingRuns("d")).rejects.toBeInstanceOf(
      SessionRejectedError
    )
    const refused = await link.pendingRuns("d").catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(DaemonError)
    expect(refused).not.toBeInstanceOf(ServerUnreachableError)

    const offline = new HttpServerLink("http://server.test", (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch)
    await expect(offline.listRepos("d")).rejects.toBeInstanceOf(
      ServerUnreachableError
    )
  })

  it("does not follow deployment SSO redirects or mistake their 401 for device rejection", async () => {
    let directRejection = false
    const { fetch, calls } = scripted(call => directRejection
      ? json({ error: "Unauthorized" }, 401)
      : call.redirect === "manual"
        ? Response.redirect("https://sso.example.test/login", 302)
        : json({ error: "Deployment SSO required" }, 401))
    const link = new HttpServerLink("https://preview.example.test/mikka", fetch)
    const redirected = await link.registerDevice("valid-device-session", INFO).catch((error: unknown) => error)
    expect(redirected).toBeInstanceOf(ServerUnreachableError)
    expect(redirected).not.toBeInstanceOf(SessionRejectedError)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: "/mikka/v1/devices/register", redirect: "manual" })
    await expect(link.claimCoordinator("dev-1", new AbortController().signal)).rejects.toBeInstanceOf(ServerUnreachableError)
    directRejection = true
    await expect(link.registerDevice("valid-device-session", INFO)).rejects.toBeInstanceOf(SessionRejectedError)
    expect(calls.every(call => call.auth === "Bearer valid-device-session")).toBe(true)
    const ssoResponse = json({ error: "Deployment SSO required" }, 401)
    Object.defineProperty(ssoResponse, "redirected", { value: true })
    const followed = new HttpServerLink("https://preview.example.test/mikka", scripted(() => ssoResponse).fetch)
    await expect(followed.registerDevice("valid-device-session", INFO)).rejects.toBeInstanceOf(ServerUnreachableError)
  })

  it.each(["redirect", "protection401"] as const)("preserves the saved credential on %s and removes it only for the app's 401", async protection => {
    let directRejection = false
    // Default Fetch follows the deployment's 302 and receives the SSO endpoint's 401.
    const { fetch } = scripted(call => directRejection
      ? json({ error: "Unauthorized" }, 401)
      : protection === "protection401" ? json(PROTECTION_401, 401)
      : call.redirect === "manual"
        ? Response.redirect("https://sso.example.test/login", 302)
        : json({ error: "Deployment SSO required" }, 401))
    const link = new HttpServerLink("https://preview.example.test/mikka", fetch)
    const daemon = new Daemon({ dataDir: tempDir(), flavor: "dev", agentSandbox: null, link, log: createLogger({ level: "silent" }) })
    const device = { credential: "valid-device-session" }
    // Exercise the sync boundary without starting the daemon's local RPC server.
    Reflect.set(daemon, "device", device)
    writeJsonAtomic(daemon.paths.device, device)
    await daemon.syncWithServer()
    expect(readJson(daemon.paths.device)).toEqual(device)
    expect(Reflect.get(daemon, "device").credential).toBe(device.credential)
    directRejection = true
    await daemon.syncWithServer()
    expect(readJson(daemon.paths.device)).toEqual({})
    expect(Reflect.get(daemon, "device").credential).toBeUndefined()
  })

  it.each([PROTECTION_401, { error: "Unauthorized", protection: {} }, { error: "Unknown gateway failure" }])(
    "does not revoke a session for an unrecognized direct 401 body %j", async body => {
      const { fetch } = scripted(() => json(body, 401))
      const link = new HttpServerLink("https://preview.example.test/mikka", fetch)
      await expect(link.registerDevice("valid-device-session", INFO)).rejects.toBeInstanceOf(ServerUnreachableError)
      await expect(link.claimCoordinator("dev-1", new AbortController().signal)).rejects.toBeInstanceOf(ServerUnreachableError)
    },
  )

  it.each(["Unauthorized", "authRequired"])("recognizes the app's exact %s 401 without consuming its response", async error => {
    const response = json({ error }, 401)
    const link = new HttpServerLink("https://preview.example.test/mikka", scripted(() => response).fetch)
    const call = error === "authRequired" ? link.validateSkillReceipt("run", "receipt") : link.registerDevice("revoked-session", INFO)
    await expect(call).rejects.toBeInstanceOf(SessionRejectedError)
    expect(response.bodyUsed).toBe(false)
    expect(await response.json()).toEqual({ error })
  })

  it("refuses a response that does not match the protocol", async () => {
    const { fetch } = scripted(() =>
      json({ ...assignment("r"), harness: "unknown" })
    )
    const link = new HttpServerLink("http://server.test", fetch)
    await expect(link.claimRun("d", "r")).rejects.toThrow(/unexpected response/)
  })
})

describe('machine run control without remote permission checks (#1505)', () => {
  afterEach(() => vi.useRealTimers())
  it.each(['legacy', 'push', 'fallback'] as const)('makes no auth request on idle, hint or mode switch: %s', async mode => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => { throw new Error('no per-operation or idle HTTP') })
    const link = new HttpServerLink('http://server.test', fetcher)
    link.setRunControlMode(mode)
    const controller = new AbortController()
    const gate = await link.prepareRunToolApproval({ ...assignment('run-1'), harness: 'codex', policy: defaultRunPolicy(), policyRevision: 'a'.repeat(64) }, controller.signal, () => {})
    try {
      await vi.advanceTimersByTimeAsync(600_000)
      link.invalidateRunControls()
      link.setRunControlMode(mode === 'push' ? 'fallback' : 'push')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await gate.checkLive()).toBe(true)
      controller.abort()
      expect(gate.revoked).toBe(true)
      expect(await gate.checkLive()).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
    } finally { gate.revoke() }
  })
})

describe("mikka daemon login (device authorization)", () => {
  const grant = {
    device_code: "dc-1",
    user_code: "ABCD-EFGH",
    verification_uri: "https://server.test/mikka/device",
    verification_uri_complete: "https://server.test/mikka/device?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 5,
  }

  it("shows the code, polls until approved and returns only a device token", async () => {
    const answers = [
      json({ error: "authorization_pending" }, 400),
      json({ error: "slow_down" }, 400),
      json({ access_token: `orv_${'d'.repeat(43)}`, token_type: "Bearer" }),
    ]
    const { fetch, calls } = scripted((call) =>
      call.path === "/api/auth/device/code" ? json(grant) : answers.shift()!
    )
    const waits: number[] = []
    const shown: string[] = []
    const token = await deviceLogin({
      serverUrl: "http://server.test",
      fetchImpl: fetch,
      deviceName: "build-box",
      prompt: (code) => shown.push(code.user_code),
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(token).toBe(`orv_${'d'.repeat(43)}`)
    expect(shown).toEqual(["ABCD-EFGH"])
    // The approval page shows which machine asks (RFC 8628 §5.4).
    expect(calls[0]?.body).toEqual({
      client_id: "mikka-daemon",
      device_name: "build-box",
      device_platform: process.platform,
      client_version: DAEMON_VERSION,
    })
    expect(calls[1]?.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc-1",
      client_id: "mikka-daemon",
    })
    // slow_down adds 5 s to the interval (RFC 8628).
    expect(waits).toEqual([5_000, 5_000, 10_000])
  })

  it("stops on a denied or expired code", async () => {
    for (const error of ["access_denied", "expired_token"] as const) {
      const { fetch } = scripted((call) =>
        call.path === "/api/auth/device/code"
          ? json(grant)
          : json({ error }, 400)
      )
      const failure = await deviceLogin({
        serverUrl: "http://server.test",
        fetchImpl: fetch,
        prompt: () => undefined,
        sleep: async () => undefined,
      }).catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(LoginError)
      expect((failure as LoginError).reason).toBe(error)
    }
  })

  it("never persists a web session from an unupgraded server", async () => {
    const { fetch } = scripted(call => call.path === '/mikka/api/auth/device/code'
      ? json(grant) : json({ access_token: 'browser-session-token' }))
    await expect(deviceLogin({ serverUrl: 'https://server.test/mikka', fetchImpl: fetch, prompt: () => undefined, sleep: async () => undefined }))
      .rejects.toThrow('Device login failed')
  })
})

describe('HttpServerLink.decide', () => {
  const request = { purpose: 'computer-action' as const, input: 'click Send', questions: [{ type: 'predicate' as const, name: 'safe', instructions: 'Is it safe?' }] }
  it('posts the request to the run decision route and keys answers by name', async () => {
    const { fetch, calls } = scripted(() => json({ answers: [{ type: 'predicate', name: 'safe', probability: 0.9 }, { type: 'choice', name: 'level', choice: 'low' }] }))
    const answers = await new HttpServerLink('http://server.test', fetch).decide('run/1', request)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/runs/run%2F1/decision', body: request })
    expect(answers?.get('safe')).toEqual({ type: 'predicate', name: 'safe', probability: 0.9 })
    expect(answers?.get('level')).toEqual({ type: 'choice', name: 'level', choice: 'low' })
  })
  it('returns null for no decision, a refusal, a server error or a malformed response', async () => {
    for (const response of [() => json({ answers: null }), () => json({ error: 'decisionUnavailable' }, 409), () => json({}, 503), () => json({ answers: [{ type: 'predicate', name: 'safe' }] }), () => { throw new TypeError('offline') }]) {
      const { fetch } = scripted(response)
      expect(await new HttpServerLink('http://server.test', fetch).decide('run-1', request)).toBeNull()
    }
  })
})

it('requests and decodes the initial repository only on the explicitly selected claim', async () => {
  const calls: { path: string; initial: string | null }[] = []
  const initialRepository = { repoId: 'repo-1', path: 'v2/github.com/fixture/repository', name: 'repository',
    remoteUrl: 'https://github.com/fixture/repository.git', setup: { approved: true, copyFiles: ['.env.local'], command: 'npm ci' }, networkAllow: ['registry.npmjs.org'] }
  const link = new HttpServerLink('https://fixture.invalid', (async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, initial: new Headers(init?.headers).get('x-mikka-initial-repository') })
    return json(path.endsWith('/repos') ? { repos: [initialRepository] } : { ...assignment('run-1'), repo: initialRepository })
  }) as typeof fetch)
  const first = await link.claimRun('dev-1', 'run-1', undefined, { initialRepository: true })
  expect(first.repo).toEqual(initialRepository)
  await link.claimRun('dev-1', 'run-1')
  await link.listRepos('dev-1')
  expect(calls.map(call => call.initial)).toEqual(['1', null, null])
})

it.each([undefined, { repoId: 'repo-1', setup: { approved: 'wrong' } }])('drops unknown or malformed initial settings while retaining the assignment', async initialRepository => {
  const link = new HttpServerLink('https://fixture.invalid', (async () => json({ ...assignment('run-1'), repo: initialRepository })) as typeof fetch)
  const result = await link.claimRun('dev-1', 'run-1', undefined, { initialRepository: true })
  expect(result.runId).toBe('run-1')
  expect(result.repo).toBeUndefined()
})
