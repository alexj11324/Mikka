import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { DAEMON_RPC_ERRORS } from "@mikka/protocol"
import { afterEach, describe, expect, it } from "vitest"

import type { RunChunk } from "../src/chunks"
import { Daemon } from "../src/main"
import { connectDaemonInDataDir } from "../src/rpc/client"
import {
  MAX_CONTINUES,
  MemoryServer,
  type SetupRecipe,
} from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const DEVICE = "device-1"
const daemons: Daemon[] = []

async function boot(
  server: MemoryServer,
  dataDir: string,
  speed = Number.POSITIVE_INFINITY,
  stallMs?: number
) {
  const daemon = await new Daemon({
    dataDir,
    flavor: "dev",
    link: server.link(),
    credential: "cred-1",
    harnesses: [{ harness: "mock", installed: true, version: "test" }],
    mockSpeed: speed,
    heartbeatMs: 50,
    stallMs,
    quotaSource: null,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return daemon
}

async function setup(recipe?: SetupRecipe, leaseMs?: number) {
  const repo = await makeRepo()
  const server = new MemoryServer(DEVICE, { leaseMs })
  server.addRepo(DEVICE, {
    repoId: "repo-1",
    name: "sandbox",
    path: repo,
    setup: recipe,
  })
  return { repo, server, dataDir: tempDir() }
}

function queue(server: MemoryServer, fixture: string, repoId = "repo-1") {
  return server.queueRun(DEVICE, {
    issueId: `issue-${fixture}`,
    repoId,
    baseBranch: "main",
    harness: "mock",
    prompt: "do it",
    fixture,
    verifyCommand: VERIFY,
  })
}

/** Fails when the agent left `BROKEN.md` behind (the verify-fails fixture). */
const VERIFY =
  "node -e \"process.exit(require('node:fs').existsSync('BROKEN.md') ? 1 : 0)\""

async function runToEnd(daemon: Daemon, server: MemoryServer, runId: string) {
  await daemon.syncWithServer()
  await waitFor(() => daemon.supervisor.list().find((r) => r.runId === runId))
  await daemon.supervisor.idle()
  await waitFor(() => daemon.status().pendingUploads === 0)
  return daemon.supervisor.get(runId)
}

function states(chunks: RunChunk[]) {
  return chunks.flatMap((c) =>
    c.type === "data-run-state" ? [c.data.state] : []
  )
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

describe("mock runs", () => {
  it("runs a fixture in its own worktree, writes the file change and ends in review", async () => {
    const { server, dataDir, repo } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "success-edit")
    const client = await connectDaemonInDataDir(dataDir, {
      name: "t",
      version: "0",
    })
    const started = await client.request("runs.start", { runId })
    expect(started.runId).toBe(runId)
    await daemon.supervisor.idle()
    await waitFor(() => daemon.status().pendingUploads === 0)

    const run = daemon.supervisor.get(runId)
    expect(run.state).toBe("succeeded")
    expect(run.worktree).toBe(join(dataDir, "worktrees", runId))
    expect(
      readFileSync(join(run.worktree as string, "MIKKA_MOCK.md"), "utf8")
    ).toContain("mock")
    // The main checkout is untouched.
    expect(existsSync(join(repo, "MIKKA_MOCK.md"))).toBe(false)

    const chunks = server.chunksFor(runId)
    expect(states(chunks)).toEqual([
      "preparing",
      "running",
      "finishing",
      "succeeded",
    ])
    expect(chunks.some((c) => c.type === "data-file-change")).toBe(true)
    expect(server.issueStatus.get("issue-success-edit")).toBe("in_review")
    expect(server.runs.get(runId)?.state).toBe("succeeded")
    expect(run.stopReason).toBe("submitted")
    expect(server.runs.get(runId)?.completion).toMatchObject({
      stopReason: "submitted",
      report: {
        summary: "Added MIKKA_MOCK.md with a short usage note.",
        filesChanged: ["MIKKA_MOCK.md"],
        verify: { status: "passed", command: VERIFY },
      },
    })
    expect(server.issueOwner.get("issue-success-edit")).toEqual({
      owner: "human",
      reason: "review",
    })
    expect(server.unownedRuns()).toEqual([])
    client.close()
  })

  it("refuses a repo that is not allow-listed", async () => {
    const { server, dataDir } = await setup()
    await boot(server, dataDir)
    const runId = queue(server, "success-edit", "repo-elsewhere")
    const client = await connectDaemonInDataDir(dataDir, {
      name: "t",
      version: "0",
    })
    const error = (await client
      .request("runs.start", { runId })
      .catch((e: unknown) => e)) as {
      code: number
      message: string
    }
    expect(error.code).toBe(DAEMON_RPC_ERRORS.repoNotAllowed)
    expect(error.message).toMatch(/not in this device's allow-list/)
    expect(existsSync(join(dataDir, "worktrees", runId))).toBe(false)
    client.close()
  })

  it("refuses a run pinned to another device", async () => {
    const { server, dataDir } = await setup()
    await boot(server, dataDir)
    const runId = server.queueRun("device-2", {
      issueId: "i",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "p",
    })
    const client = await connectDaemonInDataDir(dataDir, {
      name: "t",
      version: "0",
    })
    const error = (await client
      .request("runs.start", { runId })
      .catch((e: unknown) => e)) as {
      code: number
    }
    expect(error.code).toBe(DAEMON_RPC_ERRORS.runNotPinnedHere)
    client.close()
  })

  it("runs the approved setup recipe, then the repo's tests in the worktree", async () => {
    const { server, dataDir } = await setup({
      copyFiles: [".env.local"],
      command: "node -e \"require('fs').writeFileSync('setup-ran','')\"",
      approved: true,
    })
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "run-tests")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find((r) => r.runId === runId))
    await daemon.supervisor.idle()
    const worktree = daemon.supervisor.get(runId).worktree as string
    expect(readFileSync(join(worktree, ".env.local"), "utf8")).toBe(
      "SANDBOX=1\n"
    )
    const output = server
      .chunksFor(runId)
      .find((c) => c.type === "tool-output-available")
    expect(output).toMatchObject({ output: { exitCode: 0 } })
  })

  it("loses no chunks while the server is unreachable", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir, 50)
    const runId = queue(server, "long-running")
    await daemon.syncWithServer()
    await waitFor(() => server.chunksFor(runId).length > 5)
    server.online = false
    const before = server.chunksFor(runId).length
    await waitFor(() => daemon.status().pendingUploads > 5)
    expect(server.chunksFor(runId).length).toBe(before)
    server.online = true
    await daemon.supervisor.idle()
    await waitFor(() => daemon.status().pendingUploads === 0)

    const chunks = server.chunksFor(runId)
    expect(chunks.length).toBe(daemon.supervisor.get(runId).chunks)
    const deltas = chunks.flatMap((c) =>
      c.type === "text-delta" ? [c.delta] : []
    )
    expect(deltas).toEqual(
      Array.from({ length: 60 }, (_, i) => `step ${i + 1}. `)
    )
    expect(states(chunks).at(-1)).toBe("succeeded")
  })

  it("resumes an active run after the daemon restarts", async () => {
    const { server, dataDir } = await setup()
    const first = await boot(server, dataDir, 50)
    const runId = queue(server, "long-running")
    await first.syncWithServer()
    await waitFor(() => first.supervisor.get(runId).chunks > 10)
    await first.stop()
    daemons.splice(daemons.indexOf(first), 1)
    const sessionId = first.supervisor.get(runId).sessionId
    expect(first.supervisor.get(runId).state).toBe("running")

    const second = await boot(server, dataDir, 50)
    await waitFor(
      () => second.supervisor.activeRunIds().includes(runId) || undefined,
      5_000
    ).catch(() => undefined)
    await second.supervisor.idle()
    const run = second.supervisor.get(runId)
    expect(run.state).toBe("succeeded")
    expect(run.sessionId).toBe(sessionId)
    expect(existsSync(join(run.worktree as string, "notes/long-run.md"))).toBe(
      true
    )
    await waitFor(() => second.status().pendingUploads === 0)
    const deltas = server
      .chunksFor(runId)
      .flatMap((c) => (c.type === "text-delta" ? [c.delta] : []))
    // At-least-once across a restart: every step arrives, in order.
    expect([...new Set(deltas)]).toEqual(
      Array.from({ length: 60 }, (_, i) => `step ${i + 1}. `)
    )
  }, 30_000)

  it("cancels a running session", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir, 1)
    const runId = queue(server, "long-running")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")
    const run = await daemon.supervisor.cancel(runId)
    expect(run.state).toBe("cancelled")
    expect(run.stopReason).toBe("cancelled")
    await waitFor(() => daemon.status().pendingUploads === 0)
    expect(server.issueOwner.get("issue-long-running")?.owner).toBe("human")
    expect(server.unownedRuns()).toEqual([])
  })

  it("removes the worktree and branch of a cancelled run that changed nothing", async () => {
    const { repo, server, dataDir } = await setup()
    const daemon = await boot(server, dataDir, 1)
    const runId = queue(server, "long-running")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")
    await daemon.supervisor.cancel(runId)
    await waitFor(
      () =>
        git(repo, "branch", "--list", `mikka/run-${runId}`) === "" &&
        git(repo, "worktree", "list").split("\n").length === 1
    )
  })
})

// A planning run writes no code: it hands in a spec and the split it
// proposes, and the daemon turns both into the conversation's two cards
// (ADR ORV-205). Real CLIs get there through the `mikka` submit tool
// (test/real-agents.test.ts, opt-in); the fixture keeps the emission itself
// — the step that puts the cards in front of a person — covered every run.
//
// The fixture's `submit` is the report as the daemon holds it *after*
// `planFromHandoff` parsed it, so the zod defaults of plan.ts are spelled
// out (`blockedBy: []` rather than absent). The mock adapter replays a
// hand-in verbatim and runs no parse, so a fixture that leaned on a default
// would hand `emitPlanCards` a shape no real run can produce.
describe("plan runs", () => {
  const SPEC_ID = "0f2a1c9e-6b1d-4a53-9d2f-8c7e5b0a4d31"

  function queuePlan(server: MemoryServer) {
    return server.queueRun(DEVICE, {
      issueId: "issue-plan",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      kind: "plan",
      prompt: "Plan snoozing an issue.",
      fixture: "plan",
      // Set on purpose: a plan run must not run it (ADR ORV-205).
      verifyCommand: VERIFY,
    })
  }

  it("leaves a spec card and a split card, and changes no file", async () => {
    const { repo, server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = queuePlan(server)
    const run = await runToEnd(daemon, server, runId)

    expect(run.state).toBe("succeeded")
    expect(run.stopReason).toBe("submitted")
    const chunks = server.chunksFor(runId)
    const spec = chunks.find((c) => c.type === "data-spec")
    const split = chunks.find((c) => c.type === "data-split")
    const specData = spec?.type === "data-spec" ? spec.data : null
    expect(specData).toMatchObject({
      specId: SPEC_ID,
      title: "Snooze an issue until tomorrow",
      summary:
        "A member can push an issue's next scheduled run to tomorrow, and the issue shows that it is snoozed.",
    })
    // The agent's own sections reach the card unchanged, in its order.
    expect(specData?.sections).toEqual([
      {
        heading: "User stories",
        items: [
          "As a member, I want to snooze an issue, so that an agent does not start it today.",
          "Given an issue in Todo, when I snooze it until tomorrow, then no run is dispatched before tomorrow.",
        ],
      },
      {
        heading: "Requirements",
        items: [
          "FR-1: An issue can carry a snooze date.",
          "FR-2: A snoozed issue is not dispatched while the date is in the future.",
        ],
      },
      {
        heading: "Success criteria",
        items: ["SC-1: A snoozed issue produces no run before its date."],
      },
      { heading: "Out of scope", items: ["Recurring snoozes."] },
    ])
    expect(split?.type === "data-split" && split.data).toEqual({
      specId: SPEC_ID,
      summary: "Storage first, then the scheduler gate.",
      issues: [
        {
          key: "schema",
          title: "Add the snooze column and its mutator",
          note: "Store the snooze date on the issue.",
          criteria: [
            "An issue row can hold a snooze date.",
            "A member can set and clear it.",
          ],
          blockedBy: [],
        },
        {
          key: "gate",
          title: "Hold a snoozed issue out of dispatch",
          note: "The orchestrator skips an issue whose snooze date is in the future.",
          criteria: [
            "No run is dispatched for an issue snoozed until tomorrow.",
          ],
          blockedBy: ["schema"],
          parentKey: "schema",
        },
      ],
    })
    // Both cards name the same spec: the row a person approves.
    expect(
      chunks.every((c) => c.type !== "data-split" || c.data.specId === SPEC_ID)
    ).toBe(true)

    // No code: nothing changed, nothing was committed or pushed, and the
    // issue's verify command did not run.
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(chunks.some((c) => c.type === "data-publish")).toBe(false)
    expect(server.runs.get(runId)?.completion).toMatchObject({
      stopReason: "submitted",
      report: {
        filesChanged: [],
        verify: { status: "not_run" },
        plan: {
          specId: SPEC_ID,
          split: { issues: [{ key: "schema" }, { key: "gate" }] },
        },
      },
    })
  })
})

describe("clean-up of earlier leftovers", () => {
  it("sweeps empty run branches at start and keeps one with a commit", async () => {
    const { repo, server, dataDir } = await setup()
    // Left by runs this daemon has no record of: one empty, one with work.
    git(repo, "branch", "mikka/run-empty1", "main")
    git(repo, "branch", "mikka/run-work1", "main")
    git(
      repo,
      "worktree",
      "add",
      "-q",
      join(tempDir(), "wt"),
      "mikka/run-work1"
    )
    const wt = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .find((l) => l.endsWith("/wt"))
      ?.slice("worktree ".length)
    expect(wt).toBeTruthy()
    git(
      wt!,
      "-c",
      "user.name=a",
      "-c",
      "user.email=a@mikka.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "work"
    )
    await boot(server, dataDir)
    expect(git(repo, "branch", "--list", "mikka/run-empty1")).toBe("")
    expect(git(repo, "branch", "--list", "mikka/run-work1")).not.toBe("")
  })
})

// A follow-up run (a person's message, an answer, a fix) goes on with the
// earlier run's conversation in the earlier run's worktree.
describe("follow-up runs", () => {
  const BRIEF = "do it\n\nA person sent you a message.\n\nalso the docs"
  const FOLLOW_UP = "A person sent you a message.\n\nalso the docs"

  function mockSession(dataDir: string, sessionId: string) {
    return JSON.parse(
      readFileSync(join(dataDir, "adapters", `mock-${sessionId}.json`), "utf8")
    ) as { messages: string[] }
  }

  function queueFollowUp(
    server: MemoryServer,
    continuesRunId: string,
    resumeSessionId: string
  ) {
    return server.queueRun(DEVICE, {
      issueId: "issue-success-edit",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: BRIEF,
      followUp: FOLLOW_UP,
      continuesRunId,
      resumeSessionId,
      fixture: "success-edit",
      verifyCommand: VERIFY,
    })
  }

  it("continues the earlier session with only the follow-up", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "success-edit")
    const earlier = await runToEnd(daemon, server, first)
    const sessionId = earlier.sessionId as string

    const second = queueFollowUp(server, first, sessionId)
    const run = await runToEnd(daemon, server, second)
    expect(run).toMatchObject({ state: "succeeded", sessionId })
    expect(run.worktree).toBe(earlier.worktree)
    expect(
      server.runs.get(second)?.patches.some((p) => p.sessionId === sessionId)
    ).toBe(true)
    expect(mockSession(dataDir, sessionId).messages).toEqual([
      "do it",
      FOLLOW_UP,
    ])

    // The chain keeps going with the same session.
    const third = queueFollowUp(server, second, sessionId)
    expect(await runToEnd(daemon, server, third)).toMatchObject({ sessionId })
    expect(mockSession(dataDir, sessionId).messages).toHaveLength(3)
  })

  it("starts a new session with the full brief in a fresh worktree", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "success-edit")
    const earlier = await runToEnd(daemon, server, first)
    const sessionId = earlier.sessionId as string

    // The earlier worktree is unknown here: the run starts a fresh one.
    const second = queueFollowUp(server, "run-unknown", sessionId)
    const run = await runToEnd(daemon, server, second)
    expect(run.state).toBe("succeeded")
    expect(run.worktree).not.toBe(earlier.worktree)
    expect(run.sessionId).not.toBe(sessionId)
    expect(mockSession(dataDir, run.sessionId as string).messages).toEqual([
      BRIEF,
    ])
    expect(mockSession(dataDir, sessionId).messages).toEqual(["do it"])
  })

  it("starts a new session when the earlier one is gone", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "success-edit")
    const earlier = await runToEnd(daemon, server, first)

    const second = queueFollowUp(server, first, "mock-unknown")
    const run = await runToEnd(daemon, server, second)
    expect(run).toMatchObject({
      state: "succeeded",
      worktree: earlier.worktree,
    })
    expect(run.sessionId).not.toBe("mock-unknown")
    expect(mockSession(dataDir, run.sessionId as string).messages).toEqual([
      BRIEF,
    ])
  })
})

// No-stall invariant: every way a run can stop ends with an explicit stop
// reason, and the issue gets a next owner or a named wait reason. Only a
// submission whose verify passed goes to review.
describe("run stops", () => {
  it.each([
    [
      "turn-ended",
      "stopped",
      "turn_ended",
      { owner: "agent", reason: "continue" },
    ],
    ["crash", "failed", "error", { owner: "agent", reason: "retry" }],
    ["failure", "failed", "error", { owner: "agent", reason: "retry" }],
    [
      "quota",
      "stopped",
      "blocked",
      { owner: "external", reason: "quota_exhausted" },
    ],
    [
      "ask",
      "stopped",
      "asked_human",
      { owner: "human", reason: "answer_question" },
    ],
    [
      "verify-fails",
      "failed",
      "submitted",
      { owner: "agent", reason: "fix_verify" },
    ],
  ] as const)(
    "%s ends %s with stop reason %s and a next owner",
    async (fixture, state, stopReason, owner) => {
      const { server, dataDir } = await setup()
      const daemon = await boot(server, dataDir)
      const runId = queue(server, fixture)
      const run = await runToEnd(daemon, server, runId)

      expect(run.stopReason).toBe(stopReason)
      expect(server.runs.get(runId)?.completion?.stopReason).toBe(stopReason)
      expect(server.issueOwner.get(`issue-${fixture}`)).toEqual(owner)
      expect(server.issueStatus.get(`issue-${fixture}`)).toBe("in_progress")
      expect(server.unownedRuns()).toEqual([])
      expect(run.state).toBe(state)
    }
  )

  it("verify-fails: the submission is kept but verify failed", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "verify-fails")
    const run = await runToEnd(daemon, server, runId)
    expect(run.state).toBe("failed")
    expect(run.stopReason).toBe("submitted")
    expect(run.error).toBe(
      `Submitted, but the verify command failed: \`${VERIFY}\` exited with code 1`
    )
    expect(server.runs.get(runId)?.completion?.report).toMatchObject({
      filesChanged: ["BROKEN.md"],
      verify: { status: "failed" },
    })
  })

  it("asks: the question reaches the server in the report", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "ask")
    await runToEnd(daemon, server, runId)
    expect(server.runs.get(runId)?.completion?.report.openQuestions).toEqual([
      "Keep YAML config support, or move everything to JSON?",
    ])
  })

  it("stall: the watchdog stops a run with no progress as timeout", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir, Number.POSITIVE_INFINITY, 300)
    const runId = queue(server, "stall")
    const run = await runToEnd(daemon, server, runId)
    expect(run.state).toBe("failed")
    expect(run.stopReason).toBe("timeout")
    expect(server.issueOwner.get("issue-stall")).toEqual({
      owner: "agent",
      reason: "retry",
    })
    expect(server.unownedRuns()).toEqual([])
  })

  it("lease: a run whose lease cannot be renewed stops as device_lost", async () => {
    const { server, dataDir } = await setup(undefined, 300)
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "stall")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")
    expect(daemon.supervisor.get(runId).leaseExpiresAt).toBeDefined()
    // The heartbeat renews the lease while the server is reachable.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(daemon.supervisor.get(runId).state).toBe("running")

    server.online = false
    await daemon.supervisor.idle()
    expect(daemon.supervisor.get(runId).stopReason).toBe("device_lost")
    // Meanwhile the server sees an active run without a fresh lease.
    expect(server.unownedRuns()).toEqual([runId])

    server.online = true
    await waitFor(() => daemon.status().pendingUploads === 0)
    expect(server.issueOwner.get("issue-stall")).toEqual({
      owner: "external",
      reason: "device_offline",
    })
    expect(server.unownedRuns()).toEqual([])
  })

  it("hands an issue to a human after the retry cap", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    for (let i = 0; i < MAX_CONTINUES + 1; i++) {
      const runId = queue(server, "turn-ended")
      await runToEnd(daemon, server, runId)
    }
    expect(server.issueOwner.get("issue-turn-ended")).toEqual({
      owner: "human",
      reason: "needs_human",
    })
    expect(server.unownedRuns()).toEqual([])
  })
})
