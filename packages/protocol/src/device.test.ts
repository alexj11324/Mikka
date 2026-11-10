import { describe, expect, it } from "vitest"

import {
  daemonUpdateFailureSchema,
  DEVICE_ONLINE_WINDOW_MS,
  deviceHeartbeatSchema,
  devicePaths,
  devicesOnline,
  heartbeatResultSchema,
  isDeviceOnline,
  runAssignmentSchema,
  runPatchSchema,
} from "./device"
import { TASK_SECRET_MAX_CAPABILITIES, TASK_SECRET_MAX_TOKEN_BYTES } from './task-secrets'

describe("device online state", () => {
  const now = Date.parse("2026-10-16T12:00:00Z")

  it("counts a device online within the heartbeat window", () => {
    expect(isDeviceOnline(new Date(now - 1_000), now)).toBe(true)
    expect(isDeviceOnline(now - DEVICE_ONLINE_WINDOW_MS, now)).toBe(true)
    expect(isDeviceOnline(now - DEVICE_ONLINE_WINDOW_MS - 1, now)).toBe(false)
    expect(isDeviceOnline(null, now)).toBe(false)
    expect(isDeviceOnline("not a date", now)).toBe(false)
    expect(isDeviceOnline(now + 1, now)).toBe(false)
    expect(isDeviceOnline("2036-11-06T12:00:00Z", now)).toBe(false)
  })

  it("summarizes 设备 n/m 在线", () => {
    expect(
      devicesOnline(
        [
          { lastSeenAt: new Date(now - 5_000).toISOString() },
          { lastSeenAt: new Date(now - 10 * 60_000) },
          { lastSeenAt: null },
        ],
        now
      )
    ).toEqual({ online: 1, total: 3 })
  })
})

describe("device link schemas", () => {
  it("escapes ids into one path segment each", () => {
    expect(devicePaths.claim("d/1", "r 2")).toBe(
      "/v1/devices/d%2F1/runs/r%202/claim"
    )
    expect(devicePaths.pendingRuns("d")).toBe("/v1/devices/d/runs?state=queued")
  })

  it("parses a heartbeat and its result", () => {
    const hb = deviceHeartbeatSchema.parse({
      harnesses: [{ harness: "mock", installed: true, version: "0.0.1" }],
      runs: [{ runId: "r1", lastProgressAt: "2026-10-16T12:00:00.000Z" }],
      worktreeDiskBytes: 0,
    })
    expect(hb.runs).toHaveLength(1)
    expect(
      heartbeatResultSchema.parse({ leases: { r1: "2026-10-16T12:01:30Z" } })
    ).toEqual({ leases: { r1: "2026-10-16T12:01:30Z" } })
  })

  it("refuses an assignment without a base branch or with an unknown harness", () => {
    const base = {
      runId: "r1",
      issueId: "i1",
      deviceId: "d1",
      repoId: "repo",
      baseBranch: "main",
      harness: "mock",
      prompt: "p",
    }
    expect(runAssignmentSchema.safeParse(base).success).toBe(true)
    expect(
      runAssignmentSchema.safeParse({ ...base, baseBranch: "" }).success
    ).toBe(false)
    expect(
      runAssignmentSchema.safeParse({ ...base, harness: "gpt" }).success
    ).toBe(false)
  })

  it('retains the bounded canonical catalogue through the real assignment parser while old claims omit it', () => {
    const base = { runId: 'r1', issueId: 'i1', deviceId: 'd1', repoId: 'repo', harness: 'codex', prompt: 'p' }
    const authority = { url: 'https://mikka.example.invalid/api/mcp', token: 'mkw_fixture' }
    const catalogue = { version: 1, tool: { name: 'record_decision', title: 'Record', description: 'Static tool metadata',
      inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'] },
      annotations: { idempotentHint: true } } }
    expect(runAssignmentSchema.parse({ ...base, mcp: { ...authority, decisionCatalogue: catalogue } }).mcp?.decisionCatalogue).toEqual(catalogue)
    expect(runAssignmentSchema.parse({ ...base, mcp: authority }).mcp).not.toHaveProperty('decisionCatalogue')
    for (const changed of [{ ...catalogue, version: 2 }, { ...catalogue, extra: true },
      { ...catalogue, tool: { ...catalogue.tool, name: 'another_tool' } },
      { ...catalogue, tool: { ...catalogue.tool, inputSchema: { type: 'object', description: 'x'.repeat(33_000) } } }])
      expect(runAssignmentSchema.safeParse({ ...base, mcp: { ...authority, decisionCatalogue: changed } }).success).toBe(false)
  })

  it("takes one strict model credential, never with a subscription binding", () => {
    const base = { runId: "r1", issueId: "i1", deviceId: "d1", repoId: "repo", harness: "claude_code", prompt: "p" }
    const provider = { kind: "provider", protocol: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", key: "sk-test-0000" }
    expect(runAssignmentSchema.parse({ ...base, modelCredential: provider }).modelCredential).toEqual(provider)
    expect(runAssignmentSchema.safeParse({ ...base, modelCredential: { kind: "api_key", key: "sk-test-0000" } }).success).toBe(true)
    for (const modelCredential of [
      { ...provider, baseUrl: "http://api.deepseek.com/anthropic" },
      { ...provider, baseUrl: "https://user:pass@api.deepseek.com" },
      { ...provider, baseUrl: "https://api.deepseek.com/?x=1" },
      { ...provider, key: "sk-test\nX-Injected: 1" },
      { ...provider, key: "sk-test\0" },
      { ...provider, key: "" },
      { ...provider, key: "k".repeat(4_097) },
      { ...provider, protocol: "gemini" },
      { ...provider, extra: true },
    ]) expect(runAssignmentSchema.safeParse({ ...base, modelCredential }).success).toBe(false)
    const subscriptionBinding = { bindingId: "00000000-0000-4000-8000-000000000001", ownerId: "o", workspaceId: "00000000-0000-4000-8000-000000000002", consumerId: "00000000-0000-4000-8000-000000000003", route: "claude_code_cli" }
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionBinding }).success).toBe(true)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionBinding, modelCredential: provider }).success).toBe(false)
  })

  it("accepts a prepared subscription lease only with its matching native harness and binding", () => {
    const subscriptionBinding = { bindingId: "00000000-0000-4000-8000-000000000001", ownerId: "o", workspaceId: "00000000-0000-4000-8000-000000000002", consumerId: "00000000-0000-4000-8000-000000000003", route: "claude_code_cli" }
    const subscriptionLease = { route: "claude_code_cli", modelId: "claude-haiku-5-5", revision: 1, accountId: "fixture", expiresAt: "2026-11-06T21:00:00.000Z", accessToken: "fixture-access" }
    const base = { runId: "r1", issueId: "i1", deviceId: "d1", repoId: "repo", harness: "claude_code", prompt: "p", subscriptionBinding }
    expect(runAssignmentSchema.parse({ ...base, subscriptionLease }).subscriptionLease).toEqual(subscriptionLease)
    const verifiedLease = { ...subscriptionLease, modelCatalogueVerified: true }
    expect(runAssignmentSchema.parse({ ...base, subscriptionLease: verifiedLease }).subscriptionLease).toEqual(verifiedLease)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionLease: { ...subscriptionLease, modelCatalogueVerified: false } }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionLease, subscriptionBinding: undefined }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionLease, harness: "codex" }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionLease: { ...subscriptionLease, route: "codex_cli" } }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionLease: { ...subscriptionLease, accessToken: "fixture\nheader" } }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionLease, modelCredential: { kind: "api_key", key: "fixture-key" } }).success).toBe(false)
  })

  it("accepts prepared GitHub credentials with their natural expiry and keeps old assignments compatible", () => {
    const base = { runId: "r1", issueId: "i1", deviceId: "d1", repoId: "repo", harness: "codex", prompt: "p" }
    const github = { endpoint: "https://example.com/api/runs/github-token", repository: "owner/repo" }
    expect(runAssignmentSchema.safeParse({ ...base, github }).success).toBe(true)
    for (const expiresAt of [null, "2026-11-06T21:00:00.000Z"]) {
      expect(runAssignmentSchema.parse({ ...base, github: { ...github, token: "fixture-access", expiresAt } }).github?.token).toBe("fixture-access")
    }
    expect(runAssignmentSchema.safeParse({ ...base, github: { ...github, token: "fixture-access" } }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, github: { ...github, expiresAt: null } }).success).toBe(false)
    expect(runAssignmentSchema.safeParse({ ...base, github: { ...github, token: "fixture\nheader", expiresAt: null } }).success).toBe(false)
  })

  it('preserves protected task metadata alongside unchanged native and GitHub credentials', () => {
    const grant = { name: 'VENDOR_KEY', capability: 'synthetic-opaque-grant', expiresAt: '2030-01-01T00:00:00.000Z', origin: 'https://api.example.com' }
    const taskSecrets = { version: 1, endpoint: 'https://mikka.example.com/v1/task-secrets/r1', grants: [grant], unavailable: ['SIGNING_KEY'] }
    const github = { endpoint: 'https://mikka.example.com/api/runs/github-token', repository: 'owner/repo', token: 'synthetic-native-github', expiresAt: null }
    const base = { runId: 'r1', issueId: 'i1', deviceId: 'd1', repoId: 'repo', harness: 'claude_code', prompt: 'p', github, taskSecrets }
    const provider = { kind: 'provider', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', key: 'synthetic-native-model' }
    const api = runAssignmentSchema.parse({ ...base, modelCredential: provider })
    expect(api.taskSecrets).toEqual(taskSecrets)
    expect(api.github).toEqual(github)
    expect(api.modelCredential).toEqual(provider)
    expect(api.taskEnv).toBeUndefined()
    expect(api.taskSecretNames).toBeUndefined()
    const subscriptionBinding = { bindingId: '00000000-0000-4000-8000-000000000001', ownerId: 'o', workspaceId: '00000000-0000-4000-8000-000000000002', consumerId: '00000000-0000-4000-8000-000000000003', route: 'claude_code_cli' }
    const subscriptionLease = { route: 'claude_code_cli', modelId: 'claude-haiku-5-5', revision: 1, accountId: 'fixture', expiresAt: '2030-01-01T00:00:00.000Z', accessToken: 'synthetic-native-access' }
    const subscription = runAssignmentSchema.parse({ ...base, subscriptionBinding, subscriptionLease })
    expect(subscription.taskSecrets).toEqual(taskSecrets)
    expect(subscription.github).toEqual(github)
    expect(subscription.subscriptionLease).toEqual(subscriptionLease)
    expect(runAssignmentSchema.parse({ ...base, taskSecrets: undefined }).taskSecrets).toBeUndefined()
    for (const invalid of [{ ...taskSecrets, version: 2 }, { ...taskSecrets, env: { VENDOR_KEY: 'plaintext' } },
      { ...taskSecrets, grants: [{ ...grant, secret: 'plaintext' }] }, { ...taskSecrets, grants: [{ ...grant, name: 'bad-name' }] },
      { ...taskSecrets, grants: [{ ...grant, expiresAt: 'never' }] }]) {
      expect(runAssignmentSchema.safeParse({ ...base, taskSecrets: invalid }).success).toBe(false)
    }
  })

  it('preserves required native credential isolation without accepting a downgrade', () => {
    const assignment = { runId: 'r1', issueId: 'i1', deviceId: 'd1', repoId: 'repo', harness: 'codex', prompt: 'p' }
    expect(runAssignmentSchema.parse(assignment).nativeCredentialIsolation).toBeUndefined()
    expect(runAssignmentSchema.parse({ ...assignment, nativeCredentialIsolation: 'tools_v1' }).nativeCredentialIsolation).toBe('tools_v1')
    for (const invalid of [true, 'none', 'tools_v0', 'redaction', { version: 1 }]) {
      expect(runAssignmentSchema.safeParse({ ...assignment, nativeCredentialIsolation: invalid }).success).toBe(false)
    }
  })

  it('bounds opaque assignment and heartbeat payloads while retaining renewal metadata', () => {
    const grant = { name: 'VENDOR_KEY', capability: 'synthetic-opaque-grant', expiresAt: '2030-01-01T00:00:00.000Z', origin: 'https://api.example.com' }
    const taskSecrets = { version: 1, endpoint: 'https://mikka.example.com/v1/task-secrets/r1', grants: [grant], unavailable: [] }
    const assignment = { runId: 'r1', issueId: 'i1', deviceId: 'd1', repoId: 'repo', harness: 'codex', prompt: 'p', taskSecrets }
    const heartbeat = { harnesses: [], runs: [{ runId: 'r1', lastProgressAt: '2030-01-01T00:00:00.000Z', secretCapabilities: [grant.capability] }], worktreeDiskBytes: 0 }
    expect(deviceHeartbeatSchema.parse(heartbeat).runs[0].secretCapabilities).toEqual([grant.capability])
    expect(heartbeatResultSchema.parse({ leases: { r1: grant.expiresAt }, taskSecrets: { r1: taskSecrets } }).taskSecrets).toEqual({ r1: taskSecrets })
    const largest = 'x'.repeat(TASK_SECRET_MAX_TOKEN_BYTES)
    expect(runAssignmentSchema.safeParse({ ...assignment, taskSecrets: { ...taskSecrets, grants: [{ ...grant, capability: largest }] } }).success).toBe(true)
    for (const grants of [Array.from({ length: TASK_SECRET_MAX_CAPABILITIES + 1 }, () => grant),
      [{ ...grant, capability: largest + 'x' }], Array.from({ length: 4 }, () => ({ ...grant, capability: largest }))]) {
      expect(runAssignmentSchema.safeParse({ ...assignment, taskSecrets: { ...taskSecrets, grants } }).success).toBe(false)
      expect(heartbeatResultSchema.safeParse({ leases: {}, taskSecrets: { r1: { ...taskSecrets, grants } } }).success).toBe(false)
    }
    for (const secretCapabilities of [Array(TASK_SECRET_MAX_CAPABILITIES + 1).fill(grant.capability), [largest + 'x'], Array(5).fill(largest), ['']]) {
      expect(deviceHeartbeatSchema.safeParse({ ...heartbeat, runs: [{ ...heartbeat.runs[0], secretCapabilities }] }).success).toBe(false)
    }
    expect(deviceHeartbeatSchema.safeParse({ ...heartbeat, runs: [{ ...heartbeat.runs[0], secretCapabilities: Array(4).fill(largest) }] }).success).toBe(true)
  })

  it("accepts every daemon-local state in a patch, including stopped", () => {
    expect(
      runPatchSchema.parse({ state: "stopped", stopReason: "turn_ended" })
    ).toEqual({ state: "stopped", stopReason: "turn_ended" })
  })
})

describe("daemon releases in the heartbeat answer", () => {
  it("passes plain versions and drops a malformed value instead of failing the heartbeat", () => {
    expect(heartbeatResultSchema.parse({ leases: {}, daemonVersions: { min: "0.0.299", latest: "0.0.331" } }).daemonVersions).toEqual({ min: "0.0.299", latest: "0.0.331" })
    for (const daemonVersions of [{ min: "0.0.299", latest: "0.0.332-beta.1" }, { latest: "0.0.331" }, "0.0.331", null])
      expect(heartbeatResultSchema.parse({ leases: {}, daemonVersions }).daemonVersions).toBeUndefined()
  })
  it("reports an update failure by code only", () => {
    const failure = { version: "0.0.331", code: "install_failed", at: "2026-11-02T21:00:00.000Z" }
    expect(daemonUpdateFailureSchema.parse(failure)).toEqual(failure)
    expect(daemonUpdateFailureSchema.safeParse({ ...failure, code: "npm ERR! 404" }).success).toBe(false)
  })
})
