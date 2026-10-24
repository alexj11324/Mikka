import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import {
  ClaudeAdapter,
  type ClaudeAdapterOptions
} from "../src/adapters/claude"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

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
    stateDir: tempDir(),
    binary,
    configDir: join(home, ".claude"),
    subscriptionAuth: source
  })
  const options = {
    runId: "external-claude",
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

for (const accessToken of ["fixture-paid", "fixture-gateway"]) {
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
