// HttpServerLink and `mikka daemon login` against a scripted fetch: paths,
// headers, credentials (the device session everywhere), status handling and response
// decoding with the packages/protocol schemas.
import { afterEach, describe, expect, it } from "vitest"

import { CLIENT_VERSION_HEADER, emptyRunReport } from "@mikka/protocol"

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
import { cleanupTempDirs, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

interface Call {
  method: string
  path: string
  auth: string | null
  version: string | null
  body: unknown
  redirect: RequestRedirect | undefined
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

  it("preserves the saved credential on a protection redirect and removes it only for a direct 401", async () => {
    let directRejection = false
    // Default Fetch follows the deployment's 302 and receives the SSO endpoint's 401.
    const { fetch } = scripted(call => directRejection
      ? json({ error: "Unauthorized" }, 401)
      : call.redirect === "manual"
        ? Response.redirect("https://sso.example.test/login", 302)
        : json({ error: "Deployment SSO required" }, 401))
    const link = new HttpServerLink("https://preview.example.test/mikka", fetch)
    const daemon = new Daemon({ dataDir: tempDir(), flavor: "dev", link, log: createLogger({ level: "silent" }) })
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
    verification_uri: "mikka-dev://device",
    verification_uri_complete: "mikka-dev://device?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 5,
  }

  it("shows the code, polls until approved and returns the session", async () => {
    const answers = [
      json({ error: "authorization_pending" }, 400),
      json({ error: "slow_down" }, 400),
      json({ access_token: "session-xyz", token_type: "Bearer" }),
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
    expect(token).toBe("session-xyz")
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
})
