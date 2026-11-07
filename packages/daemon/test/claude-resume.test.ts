// Native CLI transport with a protocol fixture; no daemon, socket or provider.
import { chmodSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

import { ClaudeAdapter } from "../src/adapters/claude"
import type { AgentEvent, AgentSession, StartOptions } from "../src/adapters/types"
import { ToolApprovalGate } from "../src/agents/tool-approval"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

async function missingSession() {
  const runId = "claude-missing-session"
  const binary = resolve(import.meta.dirname, "fakes/fake-claude.mjs")
  chmodSync(binary, 0o755)
  let liveChecks = 0
  const gate = new ToolApprovalGate(runId, { isLive: () => { liveChecks++; return true } })
  const adapter = new ClaudeAdapter({ stateDir: tempDir(), binary })
  const options: StartOptions = {
    runId, cwd: await makeRepo(), prompt: "BRIEF with the follow-up",
    continueSession: { runId: "earlier-run", sessionId: "gone-session", message: "FOLLOW_UP_ONLY" },
    toolApproval: gate, env: buildChildEnv(), log: createLogger({ level: "silent" }),
  }
  return { adapter, options, gate, liveChecks: () => liveChecks }
}

it("rechecks the same live gate before replacing a missing Claude session with the full brief", async () => {
  const fixture = await missingSession()
  let session: AgentSession | undefined
  try {
    session = await fixture.adapter.start(fixture.options)
    const events: AgentEvent[] = []
    for await (const event of session.events()) events.push(event)
    const output = events.flatMap(event => event.type === "chunk" && event.chunk.type === "text-delta" ? [event.chunk.delta] : []).join("")
    expect(session.sessionId).not.toBe("gone-session")
    expect(output).toContain("BRIEF with the follow-up")
    expect(output).not.toContain("FOLLOW_UP_ONLY")
    expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" })
    expect(fixture.liveChecks()).toBe(2)
    expect(fixture.gate.revoked).toBe(true)
  } finally {
    await session?.detach?.()
  }
})

it("revokes the gate and refuses a fresh session when the missing Claude session is required", async () => {
  const fixture = await missingSession()
  await expect(fixture.adapter.start({ ...fixture.options, requireSessionResume: true }))
    .rejects.toThrow("Original Claude question session is unavailable; refusing a fresh session")
  expect(fixture.liveChecks()).toBe(1)
  expect(fixture.gate.revoked).toBe(true)
})
