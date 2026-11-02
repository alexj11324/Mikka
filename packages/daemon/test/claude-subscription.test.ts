import { ToolApprovalGate } from "../src/agents/tool-approval"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import {
  ClaudeAdapter,
  type ClaudeAdapterOptions
} from "../src/adapters/claude"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { NoSandbox } from "../src/agents/sandbox"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

it.each([
  ['fixture-gateway', 'account_info', 'provider_refused'],
  ['fixture-unknown', 'account_info', 'source_refused'],
  ['fixture-timeout', 'account_info', 'timeout'],
  ['fixture-access', 'external_verify', 'verify_refused'],
] as const)('reports only a finite startup reason for %s', async (accessToken, phase, reason) => {
  const { adapter, options } = await fixture({ accountId: 'fixture-account',
    ...(reason === 'verify_refused' ? { verify: async () => { throw new Error('private-verify-detail-must-not-log') } } : {}),
    token: async () => ({ accountId: 'fixture-account', accessToken, expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
  const childLogger = options.log.child<string>({})
  const child = vi.spyOn(options.log, 'child').mockReturnValue(childLogger)
  const warn = vi.spyOn(childLogger, 'warn').mockImplementation(() => {})
  try {
    await expect(adapter.start(options)).rejects.toThrow('Claude subscription authentication unavailable')
    expect(warn.mock.calls[0][0]).toEqual({ event: 'claude_subscription_startup_failed', phase, reason })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-account|fixture-access|private-verify-detail/)
  } finally { warn.mockRestore(); child.mockRestore() }
})

it('rechecks revocation after native initialization before delivering the first prompt', async () => {
  const verify = vi.fn(async () => { throw new Error('fixture-access revoked') })
  const { adapter, options } = await fixture({ accountId: 'fixture-account', verify, token: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-access', expiresAt: new Date(Date.now() + 60000).toISOString() }) })
  await expect(adapter.start(options)).rejects.toThrow('Claude subscription authentication unavailable')
  expect(verify).toHaveBeenCalledOnce()
})

async function fixture(
  subscriptionAuth?: ClaudeAdapterOptions["subscriptionAuth"]
) {
  const home = tempDir("mikka-claude-owner-")
  mkdirSync(join(home, ".claude"))
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    "DO NOT READ synthetic native state"
  )
  const binary = resolve(
    import.meta.dirname,
    "fakes/fake-claude-subscription.mjs"
  )
  chmodSync(binary, 0o755)
  const source = subscriptionAuth ?? {
    accountId: "fixture-account",
    token: vi.fn(async () => ({
      accountId: "fixture-account",
      accessToken: "fixture-access",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }))
  }
  const adapter = new ClaudeAdapter({
    sandbox: new NoSandbox(),
    stateDir: tempDir(),
    binary,
    configDir: join(home, ".claude"),
    subscriptionAuth: source
  })
  const options = {
    runId: "external-claude",
    toolApproval: new ToolApprovalGate("external-claude", { isLive: () => true }),
    cwd: await makeRepo(),
    prompt: "hello",
    env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }),
    log: createLogger({ level: "silent" })
  }
  return { adapter, options, source }
}

it("delivers an access-only lease through the native input without reading host login", async () => {
  const { adapter, options, source } = await fixture()
  const session = await adapter.start(options)
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(source.token).toHaveBeenCalledOnce()
  expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
  expect(JSON.stringify(events)).not.toContain("fixture-access")
})

it('accepts the older explicit no-API-key response too', async () => {
  const { adapter, options } = await fixture({ accountId: 'fixture-account', token: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-legacy', expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
  const session = await adapter.start(options)
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
})

for (const accessToken of ["fixture-paid", "fixture-gateway", "fixture-unknown", "fixture-environment"]) {
  it(`refuses ${accessToken} mode before delivering a prompt`, async () => {
    const { adapter, options } = await fixture({
      accountId: "fixture-account",
      token: async () => ({
        accountId: "fixture-account",
        accessToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    })
    await expect(adapter.start(options)).rejects.toThrow(
      "Claude subscription authentication unavailable"
    )
  })
}

it("rejects another account, expired grants and API-key environment without fallback", async () => {
  for (const accountId of ["someone-else", "fixture-account"]) {
    const { adapter, options } = await fixture({
      accountId: "fixture-account",
      token: async () => ({
        accountId,
        accessToken: "fixture-access",
        expiresAt: new Date(
          accountId === "fixture-account" ? 0 : Date.now() + 60_000
        ).toISOString()
      })
    })
    await expect(adapter.start(options)).rejects.toThrow(
      "Claude subscription authentication unavailable"
    )
  }
  const { adapter, options, source } = await fixture()
  await expect(
    adapter.start({
      ...options,
      env: { ...options.env, ANTHROPIC_API_KEY: "fixture-paid" }
    })
  ).rejects.toThrow("Claude subscription authentication unavailable")
  expect(source.token).not.toHaveBeenCalled()
})

it("ends at access expiry without independent refresh or a paid fallback", async () => {
  const token = vi.fn(async () => ({
    accountId: "fixture-account",
    accessToken: "fixture-access",
    expiresAt: new Date(Date.now() + 1_500).toISOString()
  }))
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token
  })
  const session = await adapter.start({ ...options, prompt: "HANG" })
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(events.at(-1)).toMatchObject({
    type: "exit",
    outcome: "failed",
    error: "Claude subscription authentication unavailable"
  })
  expect(token).toHaveBeenCalledOnce()
})

for (const prompt of ["FAIL", "CRASH"]) {
  it(`redacts native ${prompt} diagnostics`, async () => {
    const { adapter, options } = await fixture()
    const session = await adapter.start({ ...options, prompt })
    const events = []
    for await (const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: "exit",
      outcome: "failed",
      error: "Claude subscription execution failed"
    })
    expect(JSON.stringify(events)).not.toContain("fixture-access")
  })
}
