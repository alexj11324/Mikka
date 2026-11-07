// A device subscription run: the server's access lease reaches only the CLI
// (on its pipe), never the disk, and the run's credential paths are wiped.
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { NativeLease, RunAssignment } from "@mikka/protocol"

import { cleanupTempDirs, makeRepo, tempDir } from "../test/helpers"
import { NoSandbox } from "./agents/sandbox"
import { ToolApprovalGate } from "./agents/tool-approval"
import { buildChildEnv } from "./env"
import { createLogger } from "./log"
import { createLocalSubscriptionRunner } from "./subscription-local-runner"
import { SessionRejectedError } from "./server-link-http"

afterEach(cleanupTempDirs)

const RUN = "local-subscription"
const TOKEN = "fixture-run-access-token"
const lease = (patch: Partial<NativeLease> = {}): NativeLease => ({ route: "claude_code_cli", modelId: "claude-test", revision: 3, accountId: "acct-1",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), accessToken: TOKEN, ...patch })
const assignment = { runId: RUN, deviceId: "device-1", harness: "claude_code", model: "claude-test",
  subscriptionBinding: { bindingId: "b", ownerId: "o", workspaceId: "w", consumerId: "c", route: "claude_code_cli" } } as unknown as RunAssignment
const gate = () => new ToolApprovalGate(RUN, { isLive: id => id === RUN })

/** Records the token it was handed on fd 3, then speaks the fake Claude protocol. */
function recordingCli(record: string) {
  const file = join(tempDir(), "claude.mjs")
  writeFileSync(file, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
const token = readFileSync(3, "utf8")
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ token, env: Object.keys(process.env).filter(key => /TOKEN|KEY|SECRET/.test(key) && !/^GIT_CONFIG_KEY_[0-9]+$/.test(key)), gitConfig: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_CONFIG_(?:KEY|VALUE)_[0-9]+$/.test(key))) }))
const child = spawn(process.execPath, [${JSON.stringify(resolve(import.meta.dirname, "../test/fakes/fake-claude-subscription.mjs"))}, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit", "pipe"] })
child.stdio[3].end(token)
child.on("exit", code => process.exit(code ?? 1))
`)
  chmodSync(file, 0o755)
  return file
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe("local subscription runs", () => {
  it.each([false, true])("hands the run's access lease to the CLI on its pipe only (claim bundle: %s)", async bundled => {
    const record = join(tempDir(), "record.json")
    const stateDir = join(tempDir(), "adapters")
    const asked: string[] = []
    const runner = createLocalSubscriptionRunner({
      stateDir,
      link: { nativeLease: async (deviceId, runId) => { asked.push(`${deviceId}/${runId}`); return lease() } },
      claude: { sandbox: new NoSandbox(), stateDir, binary: recordingCli(record) },
      codex: { sandbox: new NoSandbox(), stateDir },
    })
    const session = await runner.start({ ...assignment, ...(bundled ? { subscriptionLease: lease() } : {}) }, { runId: RUN, cwd: await makeRepo(), prompt: "hello", model: "claude-test",
      env: buildChildEnv(), log: createLogger({ level: "silent" }), toolApproval: gate() })
    const events = []
    for await (const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
    const seen = JSON.parse(readFileSync(record, "utf8"))
    expect(seen.token).toBe(TOKEN)
    expect(seen.env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"])
    // The git config entries are the run's own maintenance settings, nothing else.
    expect(seen.gitConfig).toEqual({ GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0" })
    expect(asked).toEqual(bundled ? [] : [`device-1/${RUN}`])
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    for (const file of filesUnder(stateDir)) expect(readFileSync(file, "utf8")).not.toContain(TOKEN)
  })

  it("fails only this run when the server refuses the lease as unauthorized (401)", async () => {
    // HttpServerLink turns the device API's 401 into SessionRejectedError; the daemon signs out
    // (rejectDeviceSession) only on that exact error from its command/sync loops. A run start
    // must surface its own failure instead, so a refused lease never clears the device credential.
    const stateDir = join(tempDir(), "adapters")
    const runner = createLocalSubscriptionRunner({
      stateDir, link: { nativeLease: async () => { throw new SessionRejectedError() } },
      claude: { sandbox: new NoSandbox(), stateDir }, codex: { sandbox: new NoSandbox(), stateDir },
    })
    const started = runner.start(assignment, { runId: RUN, cwd: await makeRepo(), prompt: "x", model: "claude-test", env: buildChildEnv(),
      log: createLogger({ level: "silent" }), toolApproval: gate() })
    const failure = await started.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(SessionRejectedError)
    expect((failure as Error).message).toBe("subscription_local_runtime_unavailable (lease_refused)")
    // The server's refusal is kept as the cause, not swallowed.
    expect(failure).toMatchObject({ code: "subscription_local_runtime_unavailable", detail: "lease_refused" })
    expect((failure as Error).cause).toBeInstanceOf(SessionRejectedError)
  })

  it.each([
    ["a lease for another route", lease({ route: "codex_cli" }), "lease_invalid"],
    ["an expired lease", lease({ expiresAt: new Date(Date.now() - 1000).toISOString() }), "lease_invalid"],
    ["a lease for another model", lease({ modelId: "other" }), "model_mismatch"],
  ])("refuses to start on %s, saying which check failed", async (_name, value, detail) => {
    const stateDir = join(tempDir(), "adapters")
    const runner = createLocalSubscriptionRunner({
      stateDir, link: { nativeLease: async () => value },
      claude: { sandbox: new NoSandbox(), stateDir }, codex: { sandbox: new NoSandbox(), stateDir },
    })
    await expect(runner.start(assignment, { runId: RUN, cwd: await makeRepo(), prompt: "x", model: "claude-test", env: buildChildEnv(),
      log: createLogger({ level: "silent" }), toolApproval: gate() })).rejects.toMatchObject({
      code: "subscription_local_runtime_unavailable", detail, message: `subscription_local_runtime_unavailable (${detail})` })
  })

  it("gives each distinct cause its own detail and keeps the original error", async () => {
    const stateDir = join(tempDir(), "adapters")
    type Patch = { link?: () => Promise<NativeLease>; assignment?: RunAssignment; env?: Record<string, string>; binary?: string }
    const start = async (patch: Patch = {}) => {
      const runner = createLocalSubscriptionRunner({
        stateDir, link: { nativeLease: patch.link ?? (async () => lease()) },
        claude: { sandbox: new NoSandbox(), stateDir, ...(patch.binary ? { binary: patch.binary } : {}) }, codex: { sandbox: new NoSandbox(), stateDir },
      })
      return runner.start(patch.assignment ?? assignment, { runId: RUN, cwd: await makeRepo(), prompt: "x", model: "claude-test", env: patch.env ?? buildChildEnv(),
        log: createLogger({ level: "silent" }), toolApproval: gate() })
        .then(() => null, (error: unknown) => error as Error & { code?: string; detail?: string })
    }
    const refused = new Error("lease endpoint said no")
    const failures = {
      assignment_invalid: await start({ assignment: { ...assignment, subscriptionBinding: undefined } as unknown as RunAssignment }),
      lease_refused: await start({ link: async () => { throw refused } }),
      lease_invalid: await start({ link: async () => lease({ route: "codex_cli" }) }),
      model_mismatch: await start({ link: async () => lease({ modelId: "other" }) }),
      env_not_clean: await start({ env: { ...buildChildEnv(), ANTHROPIC_API_KEY: "not-allowed" } }),
      adapter_start_failed: await start({ binary: join(tempDir(), "missing-claude") }),
    }
    for (const [detail, failure] of Object.entries(failures)) {
      expect(failure, detail).toMatchObject({ code: "subscription_local_runtime_unavailable", detail })
      // The message is the code and detail only, never the cause's text.
      expect(failure?.message, detail).toBe(`subscription_local_runtime_unavailable (${detail})`)
    }
    expect(failures.lease_refused?.cause).toBe(refused)
    expect(failures.adapter_start_failed?.cause).toBeInstanceOf(Error)
    expect(new Set(Object.values(failures).map(failure => failure?.detail)).size).toBe(Object.keys(failures).length)
  })
})
