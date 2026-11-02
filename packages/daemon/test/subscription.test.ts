import { chmodSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { invalidateSubscriptionConnection } from "@mikka/protocol/subscription"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  subscriptionFixture,
  SUBSCRIPTION_TEST_NOW as NOW,
} from "../../../tests/fixtures/subscription"
import { ClaudeAdapter } from "../src/adapters/claude"
import { CodexAdapter } from "../src/adapters/codex"
import type {
  AgentAdapter,
  AgentSession,
  StartOptions,
} from "../src/adapters/types"
import { NoSandbox } from "../src/agents/sandbox"
import { ToolApprovalGate } from "../src/agents/tool-approval"
import { buildChildEnv } from "../src/env"
import { createLogger } from "../src/log"
import { startSubscriptionSession } from "../src/subscription"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(cleanupTempDirs)

function options(): StartOptions {
  const home = tempDir("mikka-byos-owner-")
  return {
    runId: "fixture-run",
    cwd: tempDir("mikka-byos-repo-"),
    prompt: "MODEL",
    model: "fixture-model",
    env: buildChildEnv({
      host: { PATH: process.env.PATH, HOME: home, USER: "fixture" },
    }),
    log: createLogger({ level: "silent" }),
  }
}

function fakeBackend() {
  const { use, access } = subscriptionFixture()
  const session: AgentSession = {
    sessionId: "fixture-session",
    async *events() {},
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  const adapter: AgentAdapter = {
    harness: "codex",
    capabilities: { supportsInterject: true, supportsResume: false },
    envAllow: [],
    start: vi.fn(async () => session),
    resume: vi.fn(async () => session),
  }
  return {
    use,
    access,
    session,
    adapter,
    backend: {
      access: async () => access,
      adapter: vi.fn(async () => adapter),
    },
  }
}

describe("hosted subscription seam", () => {
  it.each(["codex_cli", "claude_code_cli"] as const)(
    "reuses %s's existing adapter across tasks with synthetic CLIs",
    async (route) => {
      const { use, access } = subscriptionFixture(route)
      const base = { ...options(), cwd: await makeRepo() }
      const stateDir = tempDir("mikka-byos-state-")
      // Both paths use explicitly synthetic account directories. Never resolve
      // the real process HOME / auth cache, and never call a provider or E2B.
      const accountHome = join(base.env.HOME, route)
      mkdirSync(accountHome)
      const binary = resolve(
        import.meta.dirname,
        "fakes",
        route === "codex_cli" ? "fake-codex.mjs" : "fake-claude.mjs",
      )
      chmodSync(binary, 0o755)
      const adapter =
        route === "codex_cli"
          ? new CodexAdapter({
              sandbox: new NoSandbox(),
              stateDir,
              binary,
              userHome: accountHome,
            })
          : new ClaudeAdapter({ sandbox:new NoSandbox(), stateDir, binary, configDir: accountHome })
      const backend = {
        access: async () => access,
        adapter: async () => adapter,
      }
      for (let task = 0; task < 2; task++) {
        const session = await startSubscriptionSession(
          use,
          { ...base, runId: `fixture-${task}`, toolApproval: new ToolApprovalGate(`fixture-${task}`, { isLive: () => true }) },
          backend,
          () => NOW,
        )
        let text = ""
        const exits = []
        try {
          for await (const event of session.events()) {
            if (event.type === "chunk" && event.chunk.type === "text-delta")
              text += event.chunk.delta
            if (event.type === "exit") exits.push(event)
          }
        } finally {
          await session.cancel()
        }
        expect(text).toContain("model: fixture-model")
        expect(exits).toHaveLength(1)
        expect(exits[0].outcome).toBe("succeeded")
      }
    },
  )

  it.each([
    "E2B_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "CODEX_HOME",
  ])("refuses polluted %s before constructing a runner", async (name) => {
    const { use, backend } = fakeBackend()
    const base = options()
    await expect(
      startSubscriptionSession(
        use,
        { ...base, env: { ...base.env, [name]: "placeholder" } },
        backend,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: "isolation_required" })
    expect(backend.adapter).not.toHaveBeenCalled()
  })

  it("rejects a different native adapter instead of rerouting", async () => {
    const { use, backend, adapter } = fakeBackend()
    Object.assign(adapter, { harness: "claude_code" })
    await expect(
      startSubscriptionSession(use, options(), backend, () => NOW),
    ).rejects.toMatchObject({ code: "binding_mismatch" })
    expect(adapter.start).not.toHaveBeenCalled()
  })

  it("rechecks after runner creation and never starts with a revoked binding", async () => {
    const { use, access, backend, adapter } = fakeBackend()
    backend.adapter.mockImplementation(async () => {
      access.connection = invalidateSubscriptionConnection(
        access.connection!,
        "disconnected",
      )
      return adapter
    })
    await expect(
      startSubscriptionSession(use, options(), backend, () => NOW),
    ).rejects.toMatchObject({ code: "disconnected" })
    expect(adapter.start).not.toHaveBeenCalled()
  })

  it("refuses arbitrary native session continuation without an account/session ledger", async () => {
    const { use, backend } = fakeBackend()
    await expect(
      startSubscriptionSession(
        use,
        {
          ...options(),
          continueSession: {
            sessionId: "someone-elses",
            runId: "other",
            message: "continue",
          },
        },
        backend,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: "binding_mismatch" })
  })

  it("cancels and refuses interjections after disconnect", async () => {
    const { use, access, backend, session } = fakeBackend()
    const started = await startSubscriptionSession(
      use,
      options(),
      backend,
      () => NOW,
    )
    access.connection = invalidateSubscriptionConnection(
      access.connection!,
      "disconnected",
    )
    await expect(started.send("continue")).rejects.toMatchObject({
      code: "disconnected",
    })
    expect(session.cancel).toHaveBeenCalledOnce()
    expect(session.send).not.toHaveBeenCalled()
  })
})
