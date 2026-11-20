import { describe, expect, it } from "vitest"

import {
  daemonUpdateFailureSchema,
  devicePaths,
  deviceReportResultSchema,
  deviceReportSchema,
  deviceSessionReportSchema,
  devicesOnline,
  isDeviceOnline,
  runAssignmentSchema,
  runPatchSchema,
} from "./device"
import { TASK_SECRET_MAX_CAPABILITIES, TASK_SECRET_MAX_TOKEN_BYTES } from './task-secrets'

describe("device online state", () => {
  const opened = "2026-10-16T12:00:00.000Z"

  it("counts a device online while its gateway session is open", () => {
    expect(isDeviceOnline({ sessionOpenedAt: opened, sessionClosedAt: null })).toBe(true)
    expect(isDeviceOnline({ sessionOpenedAt: opened, sessionClosedAt: "2026-10-16T11:59:00Z" })).toBe(true)
    expect(isDeviceOnline({ sessionOpenedAt: opened, sessionClosedAt: "2026-10-16T12:00:01Z" })).toBe(false)
    expect(isDeviceOnline({ sessionOpenedAt: null, sessionClosedAt: null })).toBe(false)
    expect(isDeviceOnline({ sessionOpenedAt: "not a date", sessionClosedAt: null })).toBe(false)
  })

  it("summarizes 设备 n/m 在线", () => {
    expect(devicesOnline([
      { sessionOpenedAt: opened, sessionClosedAt: null },
      { sessionOpenedAt: opened, sessionClosedAt: new Date("2026-10-16T12:05:00Z") },
      { sessionOpenedAt: null, sessionClosedAt: null },
    ])).toEqual({ online: 1, total: 3 })
  })
})

describe("device link schemas", () => {
  it("escapes ids into one path segment each", () => {
    expect(devicePaths.claim("d/1", "r 2")).toBe(
      "/v1/devices/d%2F1/runs/r%202/claim"
    )
    expect(devicePaths.pendingRuns("d")).toBe("/v1/devices/d/runs?state=queued")
  })

  it("parses a device report, its result and a gateway session report", () => {
    expect(deviceReportSchema.parse({})).toEqual({})
    expect(deviceReportSchema.parse({ harnesses: [{ harness: "mock", installed: true, version: "0.0.1" }] }).harnesses).toHaveLength(1)
    expect(deviceReportSchema.safeParse({ runs: [] }).success).toBe(true)
    expect(deviceReportResultSchema.parse({})).toEqual({})
    const session = { state: "connected", at: "2026-10-16T12:00:00.000Z", socketId: "socket-0001" }
    expect(deviceSessionReportSchema.parse(session)).toEqual(session)
    expect(deviceSessionReportSchema.safeParse({ ...session, state: "alive" }).success).toBe(false)
    expect(deviceSessionReportSchema.safeParse({ ...session, extra: 1 }).success).toBe(false)
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

  it("allows HTTP model credentials only for scoped Mikka gateway tokens on loopback", () => {
    const base = { runId: 'r1', issueId: 'i1', deviceId: 'd1', repoId: 'repo', harness: 'claude_code', prompt: 'p' }
    const key = 'mkg_' + 'a'.repeat(43)
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      for (const [protocol, path] of [['anthropic', '/api/model-gateway/anthropic'], ['openai', '/mikka/api/model-gateway/openai/v1']]) {
        const modelCredential = { kind: 'provider', protocol, baseUrl: `http://${hostname}:3000${path}`, key }
        expect(runAssignmentSchema.parse({ ...base, modelCredential }).modelCredential).toEqual(modelCredential)
      }
    }
    const provider = { kind: 'provider', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:3000/api/model-gateway/anthropic', key }
    for (const changed of [
      { key: 'raw-provider-key' }, { key: 'mkg_short' },
      { baseUrl: 'http://remote.example/api/model-gateway/anthropic' },
      { baseUrl: 'http://127.0.0.1:3000/v1/messages' },
      { baseUrl: 'http://127.0.0.1:3000/api/model-gateway/anthropic/' },
      { baseUrl: 'http://127.0.0.1:3000/api/model-gateway/openai/v1' },
      { baseUrl: provider.baseUrl + '?redirect=elsewhere' },
      { baseUrl: provider.baseUrl + '#fragment' },
      { baseUrl: 'http://user:pass@127.0.0.1:3000/api/model-gateway/anthropic' },
    ]) expect(runAssignmentSchema.safeParse({ ...base, modelCredential: { ...provider, ...changed } }).success).toBe(false)
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
    for (const branch of ['mikka/team-1', 'Team_fix/changes/team-1', 'team-1']) {
      expect(runAssignmentSchema.parse({ ...base, pushBranch: branch, github: { ...github, branch } }).github?.branch).toBe(branch)
    }
    for (const branch of ['main', '/team-1', 'team//team-1', 'team.lock/team-1', 'team/../team-1', 'team-0', 'team-01', 'team-9007199254740993']) {
      expect(runAssignmentSchema.safeParse({ ...base, github: { ...github, branch } }).success).toBe(false)
    }
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

  it('bounds opaque task Secret grants in an assignment', () => {
    const grant = { name: 'VENDOR_KEY', capability: 'synthetic-opaque-grant', expiresAt: '2030-01-01T00:00:00.000Z', origin: 'https://api.example.com' }
    const taskSecrets = { version: 1, endpoint: 'https://mikka.example.com/v1/task-secrets/r1', grants: [grant], unavailable: [] }
    const assignment = { runId: 'r1', issueId: 'i1', deviceId: 'd1', repoId: 'repo', harness: 'codex', prompt: 'p', taskSecrets }
    const largest = 'x'.repeat(TASK_SECRET_MAX_TOKEN_BYTES)
    expect(runAssignmentSchema.safeParse({ ...assignment, taskSecrets: { ...taskSecrets, grants: [{ ...grant, capability: largest }] } }).success).toBe(true)
    for (const grants of [Array.from({ length: TASK_SECRET_MAX_CAPABILITIES + 1 }, () => grant),
      [{ ...grant, capability: largest + 'x' }], Array.from({ length: 4 }, () => ({ ...grant, capability: largest }))]) {
      expect(runAssignmentSchema.safeParse({ ...assignment, taskSecrets: { ...taskSecrets, grants } }).success).toBe(false)
    }
  })

  it("accepts every daemon-local state in a patch, including stopped", () => {
    expect(
      runPatchSchema.parse({ state: "stopped", stopReason: "turn_ended" })
    ).toEqual({ state: "stopped", stopReason: "turn_ended" })
  })
})

describe("daemon releases in the report answer", () => {
  it("passes plain versions and drops a malformed value instead of failing the report", () => {
    expect(deviceReportResultSchema.parse({ daemonVersions: { min: "0.0.299", latest: "0.0.331" } }).daemonVersions).toEqual({ min: "0.0.299", latest: "0.0.331" })
    for (const daemonVersions of [{ min: "0.0.299", latest: "0.0.332-beta.1" }, { latest: "0.0.331" }, "0.0.331", null])
      expect(deviceReportResultSchema.parse({ daemonVersions }).daemonVersions).toBeUndefined()
  })
  it("reports an update failure by code only", () => {
    const failure = { version: "0.0.331", code: "install_failed", at: "2026-11-02T21:00:00.000Z" }
    expect(daemonUpdateFailureSchema.parse(failure)).toEqual(failure)
    expect(daemonUpdateFailureSchema.safeParse({ ...failure, code: "npm ERR! 404" }).success).toBe(false)
  })
})
