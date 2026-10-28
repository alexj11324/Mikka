// HttpServerLink and `mikka daemon login` against a scripted fetch: paths,
// headers, credentials (the device session everywhere), status handling and response
// decoding with the packages/protocol schemas.
import { describe, expect, it } from "vitest"

import { CLIENT_VERSION_HEADER, emptyRunReport } from "@mikka/protocol"

import {
  DaemonError,
  RunNotPinnedHereError,
  ServerUnreachableError,
} from "../src/errors"
import { deviceLogin, LoginError } from "../src/login"
import { HttpServerLink, SessionRejectedError } from "../src/server-link-http"

interface Call {
  method: string
  path: string
  auth: string | null
  version: string | null
  body: unknown
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
    }
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

  it("maps statuses: 5xx/429/network retry later, 409 on claim, 401 needs login", async () => {
    const statuses = [503, 429, 409, 401, 400]
    let i = 0
    const { fetch } = scripted(() => json({ error: "x" }, statuses[i++]!))
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

  it("refuses a response that does not match the protocol", async () => {
    const { fetch } = scripted(() =>
      json({ ...assignment("r"), harness: "unknown" })
    )
    const link = new HttpServerLink("http://server.test", fetch)
    await expect(link.claimRun("d", "r")).rejects.toThrow(/unexpected response/)
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
      prompt: (code) => shown.push(code.user_code),
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(token).toBe(`orv_${'d'.repeat(43)}`)
    expect(shown).toEqual(["ABCD-EFGH"])
    expect(calls[0]?.body).toEqual({ client_id: "mikka-daemon" })
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
