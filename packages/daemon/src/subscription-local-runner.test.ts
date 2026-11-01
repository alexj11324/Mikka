// A device subscription run: the CLI talks to a loopback endpoint with a
// placeholder, the server signs each request, and no token reaches the device.
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { NativeBrokerRequest, RunAssignment } from "@mikka/protocol"

import { cleanupTempDirs, makeRepo, tempDir } from "../test/helpers"
import { NoSandbox } from "./agents/sandbox"
import { ToolApprovalGate } from "./agents/tool-approval"
import { buildChildEnv } from "./env"
import { createLogger } from "./log"
import { NATIVE_AUTH_PLACEHOLDER } from "./subscription-native-broker"
import { brokerEndpoint, createLocalSubscriptionRunner } from "./subscription-local-runner"

afterEach(cleanupTempDirs)

const RUN = "local-subscription"
const context = { route: "claude_code_cli" as const, modelId: "claude-test", revision: 3, accountId: "acct-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }

/** Calls the model endpoint the way Claude Code does, then speaks the fake CLI protocol. */
function cliThatCallsTheModel(record: string) {
  const file = join(tempDir(), "claude.mjs")
  writeFileSync(file, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
const token = readFileSync(3, "utf8")
const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ model: "claude-test" }) })
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ token, base: process.env.ANTHROPIC_BASE_URL, status: response.status, body: await response.text(),
  env: Object.keys(process.env).filter(key => /TOKEN|KEY|SECRET/.test(key)) }))
const child = spawn(process.execPath, [${JSON.stringify(resolve(import.meta.dirname, "../test/fakes/fake-claude-subscription.mjs"))}, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit", "pipe"] })
child.stdio[3].end(token)
child.on("exit", code => process.exit(code ?? 1))
`)
  chmodSync(file, 0o755)
  return file
}

describe("local subscription runs", () => {
  it("send model requests through the server; the CLI only ever holds the placeholder", async () => {
    const record = join(tempDir(), "record.json")
    const requests: NativeBrokerRequest[] = []
    const stateDir = join(tempDir(), "adapters")
    const runner = createLocalSubscriptionRunner({
      stateDir,
      link: {
        nativeContext: async () => context,
        nativeRequest: async (_device, _run, payload) => {
          requests.push(payload)
          return { contentType: "application/json", body: new Response('{"signed":"by-server"}').body! }
        },
      },
      claude: { sandbox: new NoSandbox(), stateDir, binary: cliThatCallsTheModel(record) },
      codex: { sandbox: new NoSandbox(), stateDir },
    })
    const assignment = { runId: RUN, deviceId: "device-1", harness: "claude_code",
      subscriptionBinding: { bindingId: "b", ownerId: "o", workspaceId: "w", consumerId: "c", route: "claude_code_cli" } } as unknown as RunAssignment
    const gate = new ToolApprovalGate(RUN, { permission: () => "deny", ask: async () => "deny", isLive: id => id === RUN })
    const session = await runner.start(assignment, { runId: RUN, cwd: await makeRepo(), prompt: "hello", model: "claude-test",
      env: buildChildEnv(), log: createLogger({ level: "silent" }), toolApproval: gate })
    for await (const event of session.events()) if (event.type === "exit") break
    await session.cancel()
    const seen = JSON.parse(readFileSync(record, "utf8"))
    expect(seen.token).toBe(NATIVE_AUTH_PLACEHOLDER)
    expect(seen.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(seen.status).toBe(200)
    expect(seen.body).toBe('{"signed":"by-server"}')
    expect(seen.env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"])
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe("/v1/messages")
    expect(requests[0].body).toEqual({ model: "claude-test" })
    // The endpoint is gone with the run.
    await expect(fetch(seen.base + "/v1/messages", { method: "POST", body: "{}" })).rejects.toThrow()
  })

  it("refuses to start when the server's binding no longer matches the run", async () => {
    const stateDir = join(tempDir(), "adapters")
    const runner = createLocalSubscriptionRunner({
      stateDir,
      link: { nativeContext: async () => ({ ...context, route: "codex_cli" as const }), nativeRequest: async () => { throw new Error("unused") } },
      claude: { sandbox: new NoSandbox(), stateDir }, codex: { sandbox: new NoSandbox(), stateDir },
    })
    const assignment = { runId: RUN, deviceId: "device-1", harness: "claude_code",
      subscriptionBinding: { bindingId: "b", ownerId: "o", workspaceId: "w", consumerId: "c", route: "claude_code_cli" } } as unknown as RunAssignment
    const gate = new ToolApprovalGate(RUN, { permission: () => "deny", ask: async () => "deny", isLive: () => true })
    await expect(runner.start(assignment, { runId: RUN, cwd: await makeRepo(), prompt: "x", env: buildChildEnv(), log: createLogger({ level: "silent" }), toolApproval: gate }))
      .rejects.toThrow("subscription_local_runtime_unavailable")
  })
})

describe("brokerEndpoint", () => {
  it("forwards to the broker socket, mapping Codex's responses path", async () => {
    const socket = join(tempDir(), "broker.sock")
    const paths: string[] = []
    const broker = createServer((request, response) => { paths.push(request.url ?? ""); response.end("{}") })
    await new Promise<void>(done => broker.listen(socket, done))
    const codex = await brokerEndpoint(socket, "codex")
    const claude = await brokerEndpoint(socket, "claude_code")
    try {
      await fetch(`${codex.url}/backend-api/codex/responses`, { method: "POST", body: "{}" })
      await fetch(`${claude.url}/v1/messages?beta=true`, { method: "POST", body: "{}" })
      expect((await fetch(`${claude.url}/v1/messages`)).status).toBe(404)
      expect(paths).toEqual(["/responses", "/v1/messages?beta=true"])
      expect((codex.server.address() as AddressInfo).address).toBe("127.0.0.1")
    } finally {
      codex.server.close(); claude.server.close(); broker.close()
    }
  })
})
