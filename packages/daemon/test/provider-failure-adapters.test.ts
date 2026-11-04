// Real adapter/CLI transports, synthetic provider protocol events; no network.
import { chmodSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ClaudeAdapter } from "../src/adapters/claude"
import { CodexAdapter } from "../src/adapters/codex"
import type { AgentEvent, ExitEvent } from "../src/adapters/types"
import { NoSandbox } from "../src/agents/sandbox"
import { ToolApprovalGate } from "../src/agents/tool-approval"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

async function run(harness: "claude_code" | "codex", scenario: Record<string, unknown>) {
  const stateDir = tempDir(), runId = "provider-failure"
  const binary = resolve(import.meta.dirname, `fakes/fake-${harness === "claude_code" ? "claude" : "codex"}.mjs`)
  chmodSync(binary, 0o755)
  const adapter = harness === "claude_code"
    ? new ClaudeAdapter({ stateDir, binary })
    : new CodexAdapter({ stateDir, binary, sandbox: new NoSandbox() })
  const session = await adapter.start({
    runId, cwd: await makeRepo(), prompt: "PROVIDER_DIAGNOSTIC " + JSON.stringify(scenario),
    credential: { kind: "provider", protocol: harness === "claude_code" ? "anthropic" : "openai", baseUrl: "https://provider.example.test", key: "fixture-private-model-key" },
    toolApproval: new ToolApprovalGate(runId, { isLive: () => true }),
    env: buildChildEnv(), log: createLogger({ level: "silent" }),
  })
  const events: AgentEvent[] = []
  for await (const event of session.events()) events.push(event)
  const receipt = join(stateDir, "runs", runId, harness === "claude_code" ? "native-home/.claude" : "codex-home", "provider-prompts.json")
  return { events, exit: events.at(-1) as ExitEvent, prompts: JSON.parse(readFileSync(receipt, "utf8")).prompts }
}

describe.each(["claude_code", "codex"] as const)("%s provider transport", harness => {
  it.each([
    { status: 402, code: "insufficient_balance", kind: "balance", retryable: false },
    { status: 403, code: "invalid_api_key", kind: "auth", retryable: false },
    { status: 503, code: "server_error", kind: "unavailable", retryable: true },
  ])("emits a safe terminal $kind receipt without replaying the prompt", async ({ status, code, kind, retryable }) => {
    const diagnostic = JSON.stringify({ error: { code, message: "private provider diagnostic" } })
    const scenario = harness === "claude_code"
      ? { assistantError: "unknown", failure: { api_error_status: status, terminal_reason: "api_error", result: `API Error: ${status} ${diagnostic}` } }
      : { failure: { message: `unexpected status ${status}: ${diagnostic}`, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } } }
    const { events, exit, prompts } = await run(harness, scenario)
    expect(exit).toMatchObject({ type: "exit", outcome: "failed", providerFailure: { kind, retryable, status, code } })
    expect(prompts).toBe(1)
    expect(JSON.stringify(events)).not.toMatch(/private provider diagnostic|fixture-private-model-key/)
  })

  it("accepts a terminal native 402 diagnostic without structured error metadata", async () => {
    const scenario = harness === "claude_code"
      ? { failure: { result: "API Error: 402 Payment Required: private provider diagnostic" } }
      : { failure: { message: "unexpected status 402 Payment Required: private provider diagnostic" } }
    const { events, exit, prompts } = await run(harness, scenario)
    expect(exit).toMatchObject({ type: "exit", outcome: "failed", providerFailure: {
      kind: "balance", retryable: false, status: 402, code: "payment_required",
    } })
    expect(prompts).toBe(1)
    expect(JSON.stringify(events)).not.toContain("private provider diagnostic")
  })

  it("lets a native retry recover without reporting a provider failure", async () => {
    const { exit, prompts } = await run(harness, { retry: true })
    expect(exit).toMatchObject({ type: "exit", outcome: "succeeded" })
    expect(exit.providerFailure).toBeUndefined()
    expect(prompts).toBe(1)
  })

  it("does not classify model text or tool HTTP failures", async () => {
    const { exit } = await run(harness, { modelText: "API Error: 402 insufficient_balance", toolError: "HTTP 503: invalid_api_key in the application's API" })
    expect(exit).toMatchObject({ type: "exit", outcome: "succeeded" })
    expect(exit.providerFailure).toBeUndefined()
  })

  it("passes a two-retry cap to the native provider transport", async () => {
    const { events } = await run(harness, { inspectRetries: true })
    const output = events.flatMap(event => event.type === "chunk" && event.chunk.type === "text-delta" ? [event.chunk.delta] : []).join("")
    expect(JSON.parse(output)).toEqual(harness === "claude_code"
      ? { retries: "2", watchdog: "0" }
      : { request: "model_providers.mikka.request_max_retries=2", stream: "model_providers.mikka.stream_max_retries=2" })
  })
})

describe("Claude terminal network errors", () => {
  it.each([
    ["Unable to connect to API (ECONNREFUSED)", "connection_error"],
    ["Request timed out. Check your internet connection and proxy settings", "timeout"],
  ])("normalizes %s only after the CLI has ended its provider attempt", async (diagnostic, code) => {
    const { exit, prompts } = await run("claude_code", { assistantError: "unknown", failure: { result: diagnostic } })
    expect(exit).toMatchObject({ type: "exit", outcome: "failed", providerFailure: { kind: "unavailable", retryable: true, code } })
    expect(prompts).toBe(1)
  })
})

it("preserves the outer JSON-RPC billing diagnostic when Codex rejects turn/start", async () => {
  await expect(run("codex", { rpcError: {
    code: -32000,
    message: 'unexpected status 429: {"error":{"code":"insufficient_quota","message":"private provider diagnostic"}}',
    data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
  } })).rejects.toMatchObject({
    name: "ProviderFailureError",
    providerFailure: { kind: "balance", retryable: false, status: 429, code: "insufficient_quota" },
  })
})

it("retains a native Codex usageLimitExceeded signal for quota continuation", async () => {
  const { exit, prompts } = await run("codex", { failure: {
    message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded",
  } })
  expect(exit).toMatchObject({ type: "exit", outcome: "failed", quota: { resetsAt: null } })
  expect(exit.providerFailure).toBeUndefined()
  expect(prompts).toBe(1)
})
