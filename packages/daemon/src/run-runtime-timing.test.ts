import { expect, it } from "vitest"
import { HttpServerLink } from "./server-link-http"
import { ServerUnreachableError } from "./errors"
import { RunRuntimeTimings, RUNTIME_REQUEST_LIMIT, runRuntimeTimings } from "./run-runtime-timing"
import { runIdHash } from "./tracing"

const runId = "private-run", deviceId = "private-device"
const runPath = `/v1/devices/${deviceId}/runs/${runId}`

it("does not turn malformed diagnostic identity into an execution error or a zero-call receipt", async () => {
  const timings = new RunRuntimeTimings()
  const valid = timings.begin(runId, deviceId, "claude_code")
  const unavailable = [timings.begin(runId, undefined as never, "claude_code"),
    timings.begin("", deviceId, "claude_code"), timings.begin(runId, deviceId, "unknown" as never)]
  for (const observation of unavailable) {
    observation.executing(); observation.finishing()
    expect(observation.finish()).toBeUndefined()
  }
  timings.agentAccepted(undefined as never, "claude_user_ack")
  expect(await timings.backgroundCredentialRefresh(undefined as never, async () => 42)).toBe(42)
  timings.request("POST", `/v1/runs/${runId}/events`, {})(200)
  expect(valid.finish()?.requests).toHaveLength(1)
})

it("attributes GitHub credential renewal by its actual query-bound run and records only real CLI acceptance", async () => {
  let now = 0
  const timings = new RunRuntimeTimings(() => now, () => 1000 + now)
  const run = timings.begin(runId, deviceId, "claude_code")
  timings.request("POST", `/v1/devices/${deviceId}/github-token?runId=${runId}`, undefined)(200)
  now = 10; run.executing()
  timings.agentAccepted(runId, "codex_turn_start_ack")
  now = 12; timings.agentAccepted(runId, "claude_user_ack")
  now = 20; timings.agentAccepted(runId, "claude_first_event")
  await timings.backgroundCredentialRefresh(runId, async () => {
    timings.request("POST", `/v1/devices/${deviceId}/github-token?runId=${runId}`, undefined)(200)
  })
  timings.request("POST", `/v1/devices/other/github-token?runId=${runId}`, undefined)(200)
  const receipt = run.finish()!
  expect(receipt.agentAccepted).toEqual({ kind: "claude_user_ack", at: 1012, ms: 12 })
  expect(receipt.requests.map(item => item.endpoint)).toEqual(["github_credential_lease", "github_credential_refresh"])
  expect(JSON.stringify(receipt)).not.toMatch(/private-|github-token|runId=/)
})


it("counts physical sends across async contexts, separating preparation, execution, telemetry and refresh", async () => {
  let now = 0
  const timings = new RunRuntimeTimings(() => now, () => 1000 + now)
  const run = timings.begin(runId, deviceId, "claude_code")
  const lease = timings.request("POST", `${runPath}/subscription-lease`, undefined)
  now = 20; lease(200); run.executing()
  const check = timings.request("POST", `/v1/runs/${runId}/tool-approval?private=query`, { operation: "check", token: "private-token" })
  now = 35; check(200)
  const proxy = timings.request("POST", `${runPath}/subscription`, { action: "request", payload: { body: "private-prompt", path: "/private/path" } })
  const heartbeat = timings.request("POST", `/v1/devices/${deviceId}/heartbeat`, {})
  now = 45; heartbeat(200)
  now = 60; proxy(503)
  await timings.backgroundCredentialRefresh(runId, async () => {
    const refresh = timings.request("POST", `${runPath}/subscription-lease`, undefined)
    now = 70; refresh(200)
  })
  const lateLease = timings.request("POST", `${runPath}/subscription-lease`, undefined)
  now = 80; lateLease(200)
  run.finishing()
  const telemetry = timings.request("POST", `/v1/runs/${runId}/events`, { chunks: ["private-output"] })
  now = 85; telemetry(200)
  const receipt = run.finish()!
  expect(receipt).toMatchObject({ version: 1, source: "http_server_link", complete: true, truncated: false,
    startedAt: 1000, endedAt: 1085, ms: 85, executionStartMs: 20, executionEndMs: 80, runIdHash: runIdHash(runId) })
  expect(receipt.requests.map(item => [item.endpoint, item.phase, item.ms, item.outcome])).toEqual([
    ["credential_lease", "preparing", 20, "ok"], ["permission_check", "executing", 15, "ok"],
    ["provider_proxy", "executing", 25, "error"], ["device_control", "executing", 10, "ok"],
    ["credential_refresh", "executing", 10, "ok"], ["credential_lease", "executing", 10, "ok"],
    ["run_telemetry", "finishing", 5, "ok"],
  ])
  expect(receipt.counts.find(item => item.endpoint === "provider_proxy")).toMatchObject({ started: 1, completed: 1, errors: 1, ms: 25 })
  expect(receipt.counts.find(item => item.endpoint === "device_control")?.shared).toBe(true)
  expect(JSON.stringify(receipt)).not.toMatch(/private-|query|token|payload|https|\/v1/)
})

it("isolates devices and runs, accounts for unknown run routes, and excludes unrelated or tracing traffic", () => {
  const timings = new RunRuntimeTimings()
  const first = timings.begin(runId, deviceId, "claude_code"), second = timings.begin("other-run", "other-device", "codex")
  timings.request("POST", `/v1/devices/other-device/runs/${runId}/subscription`, { action: "request" })(200)
  timings.request("POST", `/v1/devices/${deviceId}/heartbeat`, {})(200)
  timings.request("POST", "/v1/traces", { "private": "content" })(200)
  timings.request("POST", "/v1/logs", { "private": "content" })(200)
  timings.request("POST", `/v1/runs/${runId}/unknown-private`, {})(200)
  timings.request("POST", `/v1/runs/%bad/tool-approval`, { operation: "check" })(200)
  const a = first.finish()!, b = second.finish()!
  expect(a.requests.map(item => item.endpoint)).toEqual(["device_control", "other_run_request"])
  expect(b.requests).toEqual([])
  expect(JSON.stringify(a)).not.toContain("unknown-private")
})

it("keeps totals after the interval cap and records pending work without inventing completed durations", () => {
  const timings = new RunRuntimeTimings()
  const run = timings.begin(runId, deviceId, "codex")
  run.executing()
  const pending = timings.request("POST", `${runPath}/subscription`, { action: "context" })
  for (let i = 0; i < RUNTIME_REQUEST_LIMIT + 5; i++) timings.request("POST", `/v1/runs/${runId}/tool-approval`, { operation: "check" })(200)
  const receipt = run.finish()!
  expect(receipt.truncated).toBe(true)
  expect(receipt.requests).toHaveLength(RUNTIME_REQUEST_LIMIT)
  expect(receipt.requests[0]).toMatchObject({ endpoint: "subscription_context", endMs: null, ms: null, outcome: "pending" })
  expect(receipt.counts.find(item => item.endpoint === "permission_check")?.started).toBe(RUNTIME_REQUEST_LIMIT + 5)
  const before = JSON.stringify(receipt)
  pending(200)
  timings.request("POST", `${runPath}/subscription`, { action: "request" })(200)
  expect(JSON.stringify(receipt)).toBe(before)
  expect(run.finish()).toBeUndefined()
})

it("counts existing provider/tool output without retaining its text, arguments, errors or identifiers", () => {
  const run = new RunRuntimeTimings().begin(runId, deviceId, "codex")
  run.executing()
  run.chunk({ type: "text-delta", delta: "private-provider-response" })
  run.chunk({ type: "reasoning-delta", delta: "" })
  run.chunk({ type: "tool-input-start", toolCallId: "private-tool" })
  run.chunk({ type: "tool-input-available", toolCallId: "private-tool", input: "private-command" })
  run.chunk({ type: "tool-output-error", toolCallId: "private-tool", errorText: "private-error" })
  run.chunk({ type: "tool-output-error", toolCallId: "private-tool", errorText: "private-error" })
  const receipt = run.finish()!
  expect(receipt).toMatchObject({ providerOutputChunks: 1, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 1 })
  expect(JSON.stringify(receipt)).not.toMatch(/private-/)
})

it("observes the real HttpServerLink fetch edge even when daemon tracing is unconfigured", async () => {
  const actualRun = "83e6a183-c568-4d27-a560-1ff592f08d9c", actualDevice = "3f317b20-284f-408a-a11f-a9d074c061b4"
  const observation = runRuntimeTimings.begin(actualRun, actualDevice, "claude_code")
  let calls = 0
  const link = new HttpServerLink("https://mikka.test", async (_url, init) => {
    calls++
    expect(init?.headers).not.toHaveProperty("traceparent")
    if (calls === 3) throw new Error("private-network-error")
    return calls === 1 ? new Response("private-provider-body", { headers: { "content-type": "text/event-stream" } }) : Response.json({})
  })
  try {
    observation.executing()
    await link.nativeRequest(actualDevice, actualRun, { path: "/v1/messages", headers: { authorization: "private-token" }, body: "private-prompt" })
    await link.updateRun(actualRun, { state: "running" })
    await expect(link.updateRun(actualRun, { state: "running" })).rejects.toBeInstanceOf(ServerUnreachableError)
    const receipt = observation.finish()!
    expect(calls).toBe(3)
    expect(receipt.requests.map(item => [item.endpoint, item.outcome])).toEqual([
      ["provider_proxy", "ok"], ["run_telemetry", "ok"], ["run_telemetry", "error"],
    ])
    expect(JSON.stringify(receipt)).not.toMatch(/private-|83e6a183|3f317b20|mikka.test/)
  } finally { observation.close() }
})

it("counts mailbox SSE and direct capture transports, and classifies skill revalidation as authorization", async () => {
  const actualRun = "83e6a183-c568-4d27-a560-1ff592f08d9c", actualDevice = "3f317b20-284f-408a-a11f-a9d074c061b4"
  const observation = runRuntimeTimings.begin(actualRun, actualDevice, "claude_code")
  const link = new HttpServerLink("https://mikka.invalid", async (_url, init) => {
    if (init?.method === "PUT") return new Response(null, { status: 204 })
    const packet = JSON.parse(String(init?.body))
    if (packet.method === "notifications/initialized") return new Response(null, { status: 202 })
    const result = packet.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [{ name: "mailbox_inbox" }] }
    return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: packet.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  })
  try {
    observation.executing()
    const mailbox = await link.prepareRunMailbox({ runId: actualRun, deviceId: actualDevice,
      mcp: { url: "https://mikka.invalid/api/mcp", token: "mkw_" + "a".repeat(43), mailbox: true } } as import("@mikka/protocol").RunAssignment,
      new AbortController().signal, () => {})
    await mailbox?.close()
    await link.sendCapture(actualRun, "capture", { target: "server" } as import("@mikka/protocol/capture").CaptureUploadResponse["upload"], Buffer.from("private-capture"), "image/png")
    await link.sendCapture(actualRun, "capture", { target: "storage", url: "https://storage.invalid/private", headers: {} } as import("@mikka/protocol/capture").CaptureUploadResponse["upload"], Buffer.from("private-capture"), "image/png")
    runRuntimeTimings.request("GET", `/v1/runs/${actualRun}/skill-receipt?receiptId=private`, undefined)(200)
    const receipt = observation.finish()!
    expect(receipt.requests.map(item => item.endpoint)).toEqual(["mailbox_operation", "mailbox_operation", "mailbox_operation", "task_data", "storage_transfer", "permission_check"])
    expect(receipt.requests.every(item => item.outcome === "ok")).toBe(true)
    expect(JSON.stringify(receipt)).not.toMatch(/private|mkw_|mikka.invalid|storage.invalid/)
  } finally { observation.close() }
})
