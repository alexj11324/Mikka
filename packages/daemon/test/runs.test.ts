import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from 'node:zlib'
import { RepositoryCache } from "../src/repositories"
import { runPolicy } from "../src/permissions"

import { DAEMON_RPC_ERRORS } from "@mikka/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RunChunk } from "../src/chunks"
import { Daemon } from "../src/main"
import { RunJournal } from "../src/runs/journal"
import { connectDaemonInDataDir } from "../src/rpc/client"
import {
  MAX_CONTINUES,
  MemoryServer,
  type SetupRecipe,
} from "../src/server-link"
import { makeRepo, tempDir, waitFor } from "./helpers"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const DEVICE = "device-1"
const daemons: Daemon[] = []

async function boot(
  server: MemoryServer,
  dataDir: string,
  speed = Number.POSITIVE_INFINITY,
  stallMs?: number,
  fixturesDir?: string
) {
  const daemon = await new Daemon({
    dataDir,
    flavor: "dev",
    agentSandbox: null,
    link: server.link(),
    credential: "cred-1",
    harnesses: [{ harness: "mock", installed: true, version: "test" }],
    mockSpeed: speed,
    heartbeatMs: 50,
    stallMs,
    fixturesDir,
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
})

describe("mock runs", () => {
  it("keeps criterion commands and preview branch through daemon reporting without trusting the agent verify", async () => {
    const { server, dataDir } = await setup()
    const fixturesDir = tempDir()
    const criterionId = "10000000-0000-4000-8000-000000000001"
    writeFileSync(join(fixturesDir, "details.jsonl"), JSON.stringify({ t: 0, submit: {
      summary: "Checked criterion", previewDatabaseBranch: "  preview/541  ",
      verify: { status: "failed", command: "forged" },
      criteria: [{ criterionId, passed: true, command: "  pnpm check:criterion  ", exitCode: 0, evidence: "passed" }],
    } }) + "\n")
    const daemon = await boot(server, dataDir, Number.POSITIVE_INFINITY, undefined, fixturesDir)
    const runId = queue(server, "details")
    await runToEnd(daemon, server, runId)
    expect(server.runs.get(runId)?.completion?.report).toMatchObject({
      previewDatabaseBranch: "preview/541",
      criteria: [{ criterionId, command: "pnpm check:criterion", exitCode: 0 }],
      verify: { status: "passed", command: VERIFY, exitCode: 0 },
    })
  })

  it("starts from the issue branch only when the trusted push policy permits it", async () => {
    const source = await makeRepo()
    git(source, "checkout", "-b", "mikka/issue-1")
    writeFileSync(join(source, "issue-branch.txt"), "earlier work\n")
    git(source, "add", "issue-branch.txt")
    git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "earlier work")
    git(source, "checkout", "main")
    const origin = join(tempDir(), "origin.git")
    git(source, "clone", "--bare", source, origin)
    const cases = [
      // Only the server's allow (an admitted GitHub App grant) fetches and pushes the issue branch; a local approval no longer stands in.
      { decision: "allow", approved: false, expected: true },
      { decision: "ask", approved: true, expected: false },
      { decision: "ask", approved: false, expected: false },
      { decision: "deny", approved: true, expected: false },
    ] as const
    for (const { decision, approved, expected } of cases) {
      const server = new MemoryServer(DEVICE)
      server.addRepo(DEVICE, { repoId: "repo-1", name: "fixture", path: origin, push: { approved, remote: "origin" } })
      const daemon = await boot(server, tempDir())
      const defaults = runPolicy(undefined)
      const runId = server.queueRun(DEVICE, {
        issueId: `issue-${decision}-${approved}`, repoId: "repo-1",
        remoteUrl: pathToFileURL(origin).href, harness: "mock", prompt: "inspect",
        pushBranch: "mikka/issue-1", fixture: "turn-ended",
        // ask is what an older server could still send over the wire; it carries no push authority.
        policy: { ...defaults, permissions: { ...defaults.permissions, git_push: decision as "allow" | "deny" } },
      })
      const run = await runToEnd(daemon, server, runId)
      // An isolated child process observes the same checkout a CLI receives.
      const observed = execFileSync(process.execPath, ["-e", "process.stdout.write(String(require('node:fs').existsSync('issue-branch.txt')))"], { cwd: run.worktree as string, encoding: "utf8" })
      expect(observed).toBe(String(expected))
      await daemon.stop()
    }
  })
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

  it("masks injected secrets (raw + base64, split across deltas) before upload; env vars and unlisted names are left", async () => {
    const SECRET = "fixture_sk_live_0123456789abcdef"
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-secret-output", repoId: "repo-1", baseBranch: "main", harness: "mock", prompt: "do it",
      fixture: "secret-output", verifyCommand: VERIFY,
      taskEnv: { API_TOKEN: SECRET, REGION: "us-east-1-region" }, taskSecretNames: ["API_TOKEN"],
    })
    await runToEnd(daemon, server, runId)
    const chunks = server.chunksFor(runId)
    const uploaded = JSON.stringify([chunks, server.runs.get(runId)?.patches, server.runs.get(runId)?.completion])
    expect(uploaded).not.toContain(SECRET)
    expect(uploaded).not.toContain(Buffer.from(SECRET).toString("base64"))
    const text = chunks.flatMap((c) => (c.type === "text-delta" ? [c.delta] : [])).join("")
    expect(text).toBe("Using the token [secret:API_TOKEN] now; b64 [secret:API_TOKEN] done. Trailing fixture_sk_live")
    expect(JSON.stringify(chunks.find((c) => c.type === "tool-input-available"))).toContain("curl -H [secret:API_TOKEN]")
    expect(server.runs.get(runId)?.completion?.report).toMatchObject({ summary: "Deployed with [secret:API_TOKEN].", nextStep: "Rotate [secret:API_TOKEN]." })
  })
  it("rejects an assignment whose repository URL differs from its approved identity", async () => {
    const { server, dataDir, repo } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-origin-mismatch", repoId: "repo-1", baseBranch: "main", harness: "mock",
      prompt: "do it", fixture: "success-edit", verifyCommand: VERIFY,
      remoteUrl: pathToFileURL(repo).href,
      expectedRepoRemote: "https://github.com/example/expected",
    })
    await daemon.syncWithServer()
    await waitFor(() => server.runs.get(runId)?.completion)
    expect(server.runs.get(runId)?.completion?.stopReason).toBe("error")
    expect(daemon.supervisor.list().some(run => run.runId === runId)).toBe(false)
    expect(existsSync(join(dataDir, "worktrees", runId))).toBe(false)
    expect(existsSync(join(repo, "MIKKA_MOCK.md"))).toBe(false)
  })

  it("accepts an approved repository URL delivered at claim without registering a checkout", async () => {
    const repo = await makeRepo()
    const remoteUrl = pathToFileURL(repo).href
    const server = new MemoryServer(DEVICE)
    const link = server.link()
    const claim = link.claimRun.bind(link)
    link.claimRun = async (deviceId, runId) => ({
      ...await claim(deviceId, runId), remoteUrl, expectedRepoRemote: remoteUrl,
    })
    const daemon = await new Daemon({ dataDir: tempDir(), flavor: "dev", agentSandbox: null, link, credential: "cred-1",
      harnesses: [{ harness: "mock", installed: true, version: "test" }], mockSpeed: Number.POSITIVE_INFINITY,
      heartbeatMs: 60_000, quotaSource: null }).start()
    daemons.push(daemon)
    await daemon.syncWithServer()
    const runId = server.queueRun(DEVICE, { issueId: "issue-new-repo", repoId: "repo-new", baseBranch: "main",
      harness: "mock", prompt: "do it", fixture: "success-edit", verifyCommand: VERIFY })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find(run => run.runId === runId))
    await daemon.supervisor.idle()
    await waitFor(() => server.runs.get(runId)?.completion)
    expect(server.repos.size).toBe(0)
    expect(server.runs.get(runId)?.completion?.stopReason).toBe("submitted")
    expect(existsSync(join(repo, "MIKKA_MOCK.md"))).toBe(false)
  })

  it("checks the fixed candidate in its cache after the remote default branch advances", async () => {
    const { server, dataDir, repo } = await setup()
    writeFileSync(join(repo, "acceptance.mjs"), "console.log('pinned candidate checked')\n")
    git(repo, "add", "acceptance.mjs")
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "candidate")
    const candidate = git(repo, "rev-parse", "HEAD")
    writeFileSync(join(repo, "later-work.txt"), "outside the fixed candidate\n")
    git(repo, "add", "later-work.txt")
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later work")
    const daemon = await boot(server, dataDir)
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-fixed-candidate", repoId: "repo-1", baseBranch: candidate, harness: "mock",
      prompt: "Check the fixed candidate", kind: "acceptance", fixture: "check-pass",
      verifyCommand: "node acceptance.mjs", policy: { ...runPolicy(undefined), readOnly: true },
    })
    const run = await runToEnd(daemon, server, runId)
    expect(run.state).toBe("succeeded")
    expect(existsSync(join(run.worktree as string, "later-work.txt"))).toBe(false)
    expect(server.runs.get(runId)?.completion?.report).toMatchObject({
      sourceCommit: candidate,
      check: { sha: candidate, readOnly: true },
      verify: { status: "passed", exitCode: 0 },
    })
    expect(server.runs.get(runId)?.completion?.report.publish).toBeUndefined()
  })

  it("refuses a local assignment without a repository URL", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
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
    expect(error.message).toMatch(/Repository URL required/)
    expect(existsSync(join(dataDir, "worktrees", runId))).toBe(false)
    await waitFor(() => daemon.status().pendingUploads === 0)
    expect(server.runs.get(runId)?.completion?.stopReason).toBe('error')
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

  it("runs approved setup from the cache without copying a user checkout file", async () => {
    const { server, dataDir } = await setup({
      copyFiles: [".env.local"],
      command: "node -e \"const fs=require('fs');fs.writeFileSync('.env.local','CACHE=1\\n');fs.writeFileSync('setup-ran','')\"",
      approved: true,
    })
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "run-tests")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find((r) => r.runId === runId))
    await daemon.supervisor.idle()
    const worktree = daemon.supervisor.get(runId).worktree as string
    expect(readFileSync(join(worktree, ".env.local"), "utf8")).toBe(
      "CACHE=1\n"
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
    const cached = new RepositoryCache(join(dataDir, 'repos')).pathFor(pathToFileURL(repo).href)
    await waitFor(
      () => git(cached, 'branch', '--list', `mikka/run-${runId}`) === '' && git(cached, 'worktree', 'list').split('\n').length === 1
    )
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
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
    const cached = await new RepositoryCache(join(dataDir, 'repos')).prepare(pathToFileURL(repo).href)
    // Left by runs this daemon has no record of: one empty, one with work.
    git(cached, "branch", "mikka/run-empty1", "main")
    git(cached, "branch", "mikka/run-work1", "main")
    git(
      cached,
      "worktree",
      "add",
      "-q",
      join(tempDir(), "wt"),
      "mikka/run-work1"
    )
    const wt = git(cached, "worktree", "list", "--porcelain")
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
    expect(git(cached, "branch", "--list", "mikka/run-empty1")).toBe("")
    expect(git(cached, "branch", "--list", "mikka/run-work1")).not.toBe("")
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
    resumeSessionId: string,
    requireSessionResume = false
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
      requireSessionResume,
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

  it("Factory external blockers retain their empty worktree for a later exact-session answer", async () => {
    const {server,dataDir}=await setup()
    const daemon=await boot(server,dataDir)
    const first=server.queueRun(DEVICE,{issueId:"issue-blocked",repoId:"repo-1",baseBranch:"main",harness:"mock",prompt:"do it",fixture:"quota",preserveQuestionWorktree:true})
    const run=await runToEnd(daemon,server,first)
    expect(run.stopReason).toBe("blocked")
    expect(await daemon.supervisor.discardIfEmpty(first)).toBe(false)
    expect(existsSync(run.worktree!)).toBe(true)
  })

  it("required question continuation rejects a mock harness even with its exact earlier session", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "success-edit")
    const earlier = await runToEnd(daemon, server, first)
    const sessionId = earlier.sessionId as string
    const second = queueFollowUp(server, first, sessionId, true)
    expect(await runToEnd(daemon, server, second)).toMatchObject({state:"failed",sessionId:null,worktree:null})
    expect(mockSession(dataDir,sessionId).messages).toEqual(["do it"])
    expect(server.runs.get(second)?.completion?.report.summary).toContain('original resumable session')
  })

  it("required question continuation cannot use a missing worktree to start a fresh mock session", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "success-edit")
    const earlier = await runToEnd(daemon, server, first)
    const sessionId=earlier.sessionId as string
    const second=queueFollowUp(server,"run-unknown",sessionId,true)
    expect(await runToEnd(daemon,server,second)).toMatchObject({state:"failed"})
    expect(mockSession(dataDir,sessionId).messages).toEqual(["do it"])
    expect(server.runs.get(second)?.completion?.report?.summary ?? '').toContain('original resumable session')
  })

  it("required question continuation rejects an unknown mock session before adapter fallback", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "success-edit")
    await runToEnd(daemon, server, first)
    const second=queueFollowUp(server,first,"mock-unknown",true)
    expect(await runToEnd(daemon,server,second)).toMatchObject({state:"failed"})
    expect(server.runs.get(second)?.completion?.report?.summary ?? '').toContain('original resumable session')
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
  it("preserves a blocked question's empty worktree durably until explicit cancellation", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "blocked-question")
    const run = await runToEnd(daemon, server, runId)
    expect(run.stopReason).toBe("blocked")
    expect(await daemon.supervisor.discardIfEmpty(runId)).toBe(false)
    expect(existsSync(run.worktree as string)).toBe(true)
    const journal = new RunJournal(join(dataDir, "runs.json"))
    expect(journal.get(runId)?.waitingQuestionId).toBe(
      "8ebea126-b259-46b1-afca-7fe845576de1"
    )
    expect(await daemon.supervisor.discardIfEmpty(runId, runId)).toBe(true)
    expect(existsSync(run.worktree as string)).toBe(false)
  })

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
    // Git/child startup on a busy runner is not a lease-timer assertion. Keep
    // real I/O/timers, but advance the shared host/server clock deliberately.
    let now = Date.now()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const daemon = await boot(server, dataDir)
      const runId = queue(server, "stall")
      await daemon.syncWithServer()
      await waitFor(() => daemon.supervisor.get(runId).state === "running")
      const firstLease = Date.parse(daemon.supervisor.get(runId).leaseExpiresAt!)
      expect(firstLease).toBe(now + 300)
      expect(daemon.supervisor.computerRunAllowed(runId)).toBe(true)
      // A real heartbeat renews the same 300ms lease before it expires.
      now += 200
      await daemon.syncWithServer()
      const renewed = Date.parse(daemon.supervisor.get(runId).leaseExpiresAt!)
      expect(renewed).toBe(now + 300)
      expect(renewed).toBeGreaterThan(firstLease)
      expect(daemon.supervisor.get(runId).state).toBe("running")
      expect(daemon.supervisor.computerRunAllowed(runId)).toBe(true)

      server.online = false
      now = renewed - 1
      expect(daemon.supervisor.computerRunAllowed(runId)).toBe(true)
      now = renewed
      expect(daemon.supervisor.computerRunAllowed(runId)).toBe(false)
      now += 1
      await daemon.supervisor.idle()
      expect(daemon.supervisor.get(runId).stopReason).toBe("device_lost")
      expect(daemon.supervisor.computerRunAllowed(runId)).toBe(false)
      // Meanwhile the server sees an active run without a fresh lease.
      expect(server.unownedRuns()).toEqual([runId])

      server.online = true
      await waitFor(() => daemon.status().pendingUploads === 0)
      expect(server.issueOwner.get("issue-stall")).toEqual({
        owner: "external",
        reason: "device_offline",
      })
      expect(server.unownedRuns()).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  it("lease: a run the server took back stops at the next heartbeat", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = queue(server, "stall")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")
    // The server gave up on this run (its lease ran out) and queued a retry.
    const held = server.runs.get(runId)
    if (held) held.state = "failed"
    await daemon.syncWithServer()
    await daemon.supervisor.idle()
    expect(daemon.supervisor.get(runId).stopReason).toBe("device_lost")
  })

  it("lease: the retry works on in the lost attempt's worktree", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "stall")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(first).state === "running")
    const worktree = daemon.supervisor.get(first).worktree as string
    // Work the agent had not committed when the machine went offline.
    writeFileSync(join(worktree, "PARTIAL.md"), "half done\n")
    const held = server.runs.get(first)
    if (held) held.state = "failed"
    const retry = server.queueRun(DEVICE, {
      issueId: "issue-stall",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "do it",
      followUp: "Your machine went offline; continue.",
      continuesRunId: first,
      requireWorktreeContinuation: true,
      fixture: "success-edit",
      verifyCommand: VERIFY,
    })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find((r) => r.runId === retry))
    await daemon.supervisor.idle()
    expect(daemon.supervisor.get(first).stopReason).toBe("device_lost")
    const run = daemon.supervisor.get(retry)
    expect(run.state).toBe("succeeded")
    expect(run.worktree).toBe(worktree)
    expect(readFileSync(join(worktree, "PARTIAL.md"), "utf8")).toBe(
      "half done\n"
    )
  })

  it('checkpoint: required local continuation blocks when the original worktree is missing', async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const runId = server.queueRun(DEVICE, { issueId: 'missing-original', repoId: 'repo-1', baseBranch: 'main',
      harness: 'mock', prompt: 'do it', continuesRunId: 'lost-worktree', requireWorktreeContinuation: true,
      fixture: 'success-edit', verifyCommand: VERIFY })
    const result = await runToEnd(daemon, server, runId)
    expect(result.stopReason).toBe('blocked')
    expect(result.sessionId).toBe(null)
    expect(result.worktree).toBe(null)
    expect(server.runs.get(runId)?.completion?.report.verify.status).toBe('not_run')
  })

  it("checkpoint: another machine takes over from the saved work", async () => {
    const { server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const first = queue(server, "stall")
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(first).state === "running")
    const worktree = daemon.supervisor.get(first).worktree as string
    writeFileSync(join(worktree, "PARTIAL.md"), "half done\n")
    // Binary content must survive the trip.
    writeFileSync(join(worktree, "blob.bin"), Buffer.from([0, 1, 2, 255, 0]))
    const link = server.link()
    await daemon.supervisor.saveCheckpoints(
      (runId, checkpoint) => link.checkpointRun!(runId, checkpoint),
      Date.now() + 10 * 60_000
    )
    const checkpoint = server.runs.get(first)?.checkpoint
    expect(checkpoint?.files).toBe(2)
    // Nothing changed since: no second upload.
    const held = server.runs.get(first)
    if (held) held.checkpoint = undefined
    await daemon.supervisor.saveCheckpoints(
      (runId, cp) => link.checkpointRun!(runId, cp),
      Date.now() + 20 * 60_000
    )
    expect(server.runs.get(first)?.checkpoint).toBeUndefined()

    // The machine is gone; the run goes on elsewhere with only the checkpoint.
    if (held) held.state = "failed"
    const takeover = server.queueRun(DEVICE, {
      issueId: "issue-stall",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "do it",
      resumeFrom: checkpoint,
      continuesRunId: 'missing-prior-worktree',
      fixture: "success-edit",
      verifyCommand: VERIFY,
    })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find((r) => r.runId === takeover))
    await daemon.supervisor.idle()
    const run = daemon.supervisor.get(takeover)
    expect(run.state).toBe("succeeded")
    expect(run.worktree).not.toBe(worktree)
    const moved = run.worktree as string
    expect(readFileSync(join(moved, "PARTIAL.md"), "utf8")).toBe("half done\n")
    expect([...readFileSync(join(moved, "blob.bin"))]).toEqual([0, 1, 2, 255, 0])
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

  it.each(['missing-base', 'conflict', 'stale', 'unavailable'])('checkpoint: %s blocks before any agent starts', async failure => {
    const { repo, server, dataDir } = await setup()
    const daemon = await boot(server, dataDir)
    const checkpoint = {
      baseCommit: failure === 'missing-base' ? 'f'.repeat(40) : git(repo, 'rev-parse', 'HEAD'),
      patch: gzipSync(Buffer.from(failure === 'conflict' ? 'not a valid git patch\n' : '')).toString('base64'),
      files: failure === 'conflict' || failure === 'unavailable' ? 1 : 0,
      takenAt: new Date(Date.now() - (failure === 'stale' ? 31 * 60_000 : 0)).toISOString(),
      ...(failure === 'unavailable' ? { unavailableReason: 'too_large' as const } : {}),
    }
    const runId = server.queueRun(DEVICE, { issueId: 'blocked-recovery', repoId: 'repo-1', baseBranch: 'main',
      harness: 'mock', prompt: 'do it', resumeFrom: checkpoint, fixture: 'success-edit', verifyCommand: VERIFY })
    const result = await runToEnd(daemon, server, runId)
    expect(result.stopReason).toBe('blocked')
    expect(result.sessionId).toBe(null)
    expect(server.runs.get(runId)?.completion?.report.verify.status).toBe('not_run')
  })
})
