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

afterEach(cleanupTempDirs)

const RUN = "local-subscription"
const TOKEN = "fixture-run-access-token"
const lease = (patch: Partial<NativeLease> = {}): NativeLease => ({ route: "claude_code_cli", modelId: "claude-test", revision: 3, accountId: "acct-1",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), accessToken: TOKEN, ...patch })
const assignment = { runId: RUN, deviceId: "device-1", harness: "claude_code",
  subscriptionBinding: { bindingId: "b", ownerId: "o", workspaceId: "w", consumerId: "c", route: "claude_code_cli" } } as unknown as RunAssignment
const gate = () => new ToolApprovalGate(RUN, { permission: () => "deny", ask: async () => "deny", isLive: id => id === RUN })

/** Records the token it was handed on fd 3, then speaks the fake Claude protocol. */
function recordingCli(record: string) {
  const file = join(tempDir(), "claude.mjs")
  writeFileSync(file, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
const token = readFileSync(3, "utf8")
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ token, env: Object.keys(process.env).filter(key => /TOKEN|KEY|SECRET/.test(key)) }))
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
  it("hand the run's access lease to the CLI on its pipe only", async () => {
    const record = join(tempDir(), "record.json")
    const stateDir = join(tempDir(), "adapters")
    const asked: string[] = []
    const runner = createLocalSubscriptionRunner({
      stateDir,
      link: { nativeLease: async (deviceId, runId) => { asked.push(`${deviceId}/${runId}`); return lease() } },
      claude: { sandbox: new NoSandbox(), stateDir, binary: recordingCli(record) },
      codex: { sandbox: new NoSandbox(), stateDir },
    })
    const session = await runner.start(assignment, { runId: RUN, cwd: await makeRepo(), prompt: "hello", model: "claude-test",
      env: buildChildEnv(), log: createLogger({ level: "silent" }), toolApproval: gate() })
    const events = []
    for await (const event of session.events()) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
    const seen = JSON.parse(readFileSync(record, "utf8"))
    expect(seen.token).toBe(TOKEN)
    expect(seen.env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"])
    expect(asked).toEqual([`device-1/${RUN}`])
    expect(JSON.stringify(events)).not.toContain(TOKEN)
    for (const file of filesUnder(stateDir)) expect(readFileSync(file, "utf8")).not.toContain(TOKEN)
  })

  it.each([
    ["a lease for another route", lease({ route: "codex_cli" })],
    ["an expired lease", lease({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
    ["a lease for another model", lease({ modelId: "other" })],
  ])("refuses to start on %s", async (_name, value) => {
    const stateDir = join(tempDir(), "adapters")
    const runner = createLocalSubscriptionRunner({
      stateDir, link: { nativeLease: async () => value },
      claude: { sandbox: new NoSandbox(), stateDir }, codex: { sandbox: new NoSandbox(), stateDir },
    })
    await expect(runner.start(assignment, { runId: RUN, cwd: await makeRepo(), prompt: "x", model: "claude-test", env: buildChildEnv(),
      log: createLogger({ level: "silent" }), toolApproval: gate() })).rejects.toThrow("subscription_local_runtime_unavailable")
  })
})
