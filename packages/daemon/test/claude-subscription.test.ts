import { ToolApprovalGate } from "../src/agents/tool-approval"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import {
  ClaudeAdapter,
  ClaudeInitializationError,
  type ClaudeAdapterOptions
} from "../src/adapters/claude"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { NoSandbox } from "../src/agents/sandbox"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

afterEach(cleanupTempDirs)

it.each([
  ['fixture-gateway', 'account_info', 'provider_refused'],
  ['fixture-unknown', 'account_info', 'source_refused'],
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

it('bounds hung CLI initialization and closes its process without delivering a prompt', async () => {
  const { adapter, options, processReceipt } = await fixture({ accountId: 'fixture-account',
    token: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-timeout', expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
  const started = Date.now()
  const starting = adapter.start(options)
  const refused = expect(starting).rejects.toMatchObject({ name: 'ClaudeInitializationError', code: 'claude_code_initialization_timeout', message: 'Claude Code initialization timed out' })
  await waitFor(() => existsSync(processReceipt))
  const receipt = () => JSON.parse(readFileSync(processReceipt, 'utf8')) as { pid: number; prompts: number }
  const pid = receipt().pid
  await refused
  expect(Date.now() - started).toBeGreaterThanOrEqual(29_000)
  expect(Date.now() - started).toBeLessThan(40_000)
  expect(receipt().prompts).toBe(0)
  expect(() => process.kill(pid, 0)).toThrow()
})

it('revokes a hung initializer promptly instead of waiting for its startup budget', async () => {
  const verify = vi.fn(async () => {})
  const { adapter, options, processReceipt } = await fixture({ accountId: 'fixture-account', verify,
    token: async () => ({ accountId: 'fixture-account', accessToken: 'fixture-timeout', expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
  const refused = expect(adapter.start(options)).rejects.toBeInstanceOf(ClaudeInitializationError)
  await waitFor(() => existsSync(processReceipt))
  const receipt = JSON.parse(readFileSync(processReceipt, 'utf8')) as { pid: number; prompts: number }
  const revoked = Date.now()
  options.toolApproval.revoke()
  await refused
  expect(Date.now() - revoked).toBeLessThan(5_000)
  expect(verify).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(processReceipt, 'utf8')).prompts).toBe(0)
  expect(() => process.kill(receipt.pid, 0)).toThrow()
})

it.each(['fixture-delayed-gateway','fixture-delayed-paid','fixture-delayed-unknown'])(
  'keeps the provider/source guard after delayed initialization: %s', async accessToken => {
    const verify = vi.fn(async () => {})
    const { adapter, options, processReceipt } = await fixture({ accountId: 'fixture-account', verify,
      token: async () => ({ accountId: 'fixture-account', accessToken, expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
    await expect(adapter.start(options)).rejects.toThrow('Claude subscription authentication unavailable')
    expect(verify).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(processReceipt, 'utf8')).prompts).toBe(0)
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
  const stateDir = tempDir()
  const adapter = new ClaudeAdapter({
    sandbox: new NoSandbox(),
    stateDir,
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
  return { adapter, options, source, processReceipt: join(stateDir, 'runs', options.runId, 'native-home', '.claude', 'fixture-process.json') }
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

for (const [prompt, category] of [
  ["FAIL", "api_error:authentication_failed"],
  ["CRASH", "cli_exited_early"],
  ["API_ERROR", "api_error:overloaded"],
  ["MAX_TURNS", "max_turns"],
  ["IMAGE_ERROR", "image_error"],
]) {
  it(`names the ${prompt} failure class and redacts its native diagnostics`, async () => {
    const { adapter, options } = await fixture()
    const childLogger = options.log.child<string>({})
    const child = vi.spyOn(options.log, 'child').mockReturnValue(childLogger)
    const warn = vi.spyOn(childLogger, 'warn').mockImplementation(() => {})
    try {
      const session = await adapter.start({ ...options, prompt })
      const events = []
      for await (const event of session.events()) events.push(event)
      expect(events.at(-1)).toMatchObject({
        type: "exit",
        outcome: "failed",
        error: `Claude subscription execution failed (${category})`
      })
      expect(JSON.stringify(events)).not.toMatch(/fixture-access|fixturesecret|private/)
      const logged = warn.mock.calls.find(([entry]) => (entry as { event?: string }).event === 'claude_subscription_turn_failed')
      expect(logged?.[0]).toMatchObject({ category })
      if (prompt !== "CRASH") expect(logged?.[0]).toMatchObject({ is_error: true, subtype: prompt === "MAX_TURNS" ? "error_max_turns" : expect.any(String) })
      if (prompt === "API_ERROR") expect(logged?.[0]).toMatchObject({ subtype: "success", api_error_status: 529, terminal_reason: "api_error", assistant_error: "overloaded" })
      if (prompt === "CRASH") expect((logged?.[0] as { stderr: string }).stderr).toContain("private upstream diagnostic [REDACTED]")
      if (prompt === "API_ERROR") expect((logged?.[0] as { stderr: string }).stderr).toContain("upstream said Authorization: Bearer [REDACTED]")
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-access|fixturesecret/)
    } finally { warn.mockRestore(); child.mockRestore() }
  })
}
