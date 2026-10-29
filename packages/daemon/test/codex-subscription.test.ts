import { ToolApprovalGate } from "../src/agents/tool-approval"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

import { CodexAdapter, type CodexAdapterOptions } from "../src/adapters/codex"
import { NoSandbox } from "../src/agents/sandbox"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

it('rechecks revocation after initialization before starting the first native turn', async () => {
  const verify = vi.fn(async () => { throw new Error('fixture-access revoked') })
  const { adapter, options } = await fixture({ accountId: 'fixture-account', verify, token: async () => ({ accessToken: 'fixture-access', chatgptAccountId: 'fixture-account' }) })
  await expect(adapter.start(options)).rejects.toThrow('Codex subscription authentication unavailable')
  expect(verify).toHaveBeenCalledOnce()
})

async function fixture(token?: CodexAdapterOptions["subscriptionAuth"]) {
  const home = tempDir("mikka-native-owner-")
  const userHome = join(home, "native")
  mkdirSync(userHome)
  // A native auth file must not be linked/read when host-managed auth is used.
  writeFileSync(
    join(userHome, "auth.json"),
    "DO NOT READ: synthetic native state"
  )
  const binary = resolve(
    import.meta.dirname,
    "fakes/fake-codex-subscription.mjs"
  )
  chmodSync(binary, 0o755)
  const stateDir = tempDir("mikka-external-state-")
  const source = token ?? {
    accountId: "fixture-account",
    token: vi.fn(async (refresh: boolean) => ({
      accessToken: refresh ? "fixture-access-rotated" : "fixture-access",
      chatgptAccountId: "fixture-account",
      chatgptPlanType: "plus"
    }))
  }
  const adapter = new CodexAdapter({
    sandbox: new NoSandbox(),
    stateDir,
    binary,
    userHome,
    subscriptionAuth: source
  })
  const options = {
    runId: "external-run",
    toolApproval: new ToolApprovalGate("external-run", { permission: () => "allow", ask: async () => "deny", isLive: () => true }),
    cwd: await makeRepo(),
    prompt: "REFRESH",
    env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }),
    log: createLogger({ level: "silent" })
  }
  return { adapter, options, source, stateDir }
}

it("logs in through official host-managed RPC and services its refresh callback with access-only material", async () => {
  const { adapter, options, source } = await fixture()
  const session = await adapter.start(options)
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(source.token).toHaveBeenNthCalledWith(1, false)
  expect(source.token).toHaveBeenNthCalledWith(2, true)
  expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
  expect(JSON.stringify(events)).not.toContain("fixture-access")
})

it("fails closed for an unsupported native auth RPC without exposing upstream errors or falling back", async () => {
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token: async () => ({
      accessToken: "fixture-unsupported",
      chatgptAccountId: "fixture-account"
    })
  })
  await expect(adapter.start(options)).rejects.toThrow(
    "Codex subscription authentication unavailable"
  )
})

it("rejects account replacement from the token broker", async () => {
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token: async () => ({
      accessToken: "fixture-access",
      chatgptAccountId: "someone-else"
    })
  })
  await expect(adapter.start(options)).rejects.toThrow(
    "Codex subscription authentication unavailable"
  )
})

it("refuses a refresh request for another account before invoking the broker", async () => {
  const { adapter, options, source } = await fixture()
  const session = await adapter.start({ ...options, prompt: "WRONG REFRESH" })
  const events = []
  for await (const event of session.events()) events.push(event)
  expect(source.token).toHaveBeenCalledOnce()
  expect(events.at(-1)).toMatchObject({
    type: "exit",
    outcome: "failed",
    error: "Codex subscription authentication unavailable"
  })
})

it("does not accept an API-key environment for subscription execution", async () => {
  const { adapter, options, source } = await fixture()
  await expect(
    adapter.start({
      ...options,
      env: { ...options.env, OPENAI_API_KEY: "fixture-paid-key" }
    })
  ).rejects.toThrow("Codex subscription authentication unavailable")
  expect(source.token).not.toHaveBeenCalled()
  expect(existsSync(join(options.cwd, "auth.json"))).toBe(false)
})

it("refuses an app-server that accepts login as a paid API-key mode", async () => {
  const { adapter, options } = await fixture({
    accountId: "fixture-account",
    token: async () => ({
      accessToken: "fixture-paid-mode",
      chatgptAccountId: "fixture-account"
    })
  })
  await expect(adapter.start(options)).rejects.toThrow(
    "Codex subscription authentication unavailable"
  )
})

it.each(["FAIL", "CRASH"])(
  "does not expose auth/provider diagnostics on %s",
  async (prompt) => {
    const { adapter, options } = await fixture()
    const session = await adapter.start({ ...options, prompt })
    const events = []
    for await (const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: "exit",
      outcome: "failed",
      error: "Codex subscription execution failed"
    })
    expect(JSON.stringify(events)).not.toContain("fixture-secret")
  }
)
