// The Claude Code, Codex and Cursor adapters driven end to end through the
// daemon, against fake CLIs that speak each real protocol (stream-json,
// `codex app-server` JSON-RPC, ACP) and call Mikka's MCP hand-in tool. The
// sandbox is off here; `agents.test.ts` and `real-agents.test.ts` cover it.
import { chmodSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { isTerminalRunState, type Harness } from "@mikka/protocol"
import { execa } from "execa"
import { afterEach, describe, expect, it } from "vitest"

import { NoSandbox } from "../src/agents/sandbox"
import type { RunChunk } from "../src/chunks"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"
import { resolveAgentSettings } from "@mikka/protocol/agent-policy"

const FAKES = resolve(import.meta.dirname, "fakes")
const BINARIES = {
  claude_code: join(FAKES, "fake-claude.mjs"),
  codex: join(FAKES, "fake-codex.mjs"),
  cursor: join(FAKES, "fake-acp.mjs"),
}
for (const file of Object.values(BINARIES)) chmodSync(file, 0o755)

const DEVICE = "device-fake"
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

async function boot(server: MemoryServer, dataDir: string) {
  const daemon = await new Daemon({
    dataDir,
    flavor: "dev",
    link: server.link(),
    credential: "cred",
    heartbeatMs: 50,
    harnesses: (["claude_code", "codex", "cursor"] as const).map((harness) => ({
      harness,
      installed: true,
      version: "fake",
    })),
    agentSandbox: new NoSandbox(),
    harnessBinaries: BINARIES,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return daemon
}

async function setup() {
  const repo = await makeRepo()
  const origin = tempDir("orvo-")
  await execa("git", ["init", "-q", "--bare", origin])
  await execa("git", ["remote", "add", "origin", origin], { cwd: repo })
  await execa("git", ["push", "-q", "origin", "main"], { cwd: repo })
  await execa("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin })
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, {
    repoId: "repo",
    name: "sandbox",
    // The fixture's upstream is cloned into the daemon cache. A user's
    // checkout is never the fetch/push target for a local thread.
    path: origin,
    push: { approved: true },
  })
  const dataDir = tempDir()
  return { repo, origin, server, dataDir, daemon: await boot(server, dataDir) }
}

function queue(
  server: MemoryServer,
  harness: Harness,
  prompt: string,
  verifyCommand = "test -f NOTES.md"
) {
  return server.queueRun(DEVICE, {
    issueId: `issue-${harness}`,
    repoId: "repo",
    baseBranch: "main",
    harness,
    prompt,
    verifyCommand,
  })
}

/** The run got going: running, or already over (a quick turn can end before a poll sees it running). */
async function started(daemon: Daemon, runId: string) {
  await daemon.syncWithServer()
  await waitFor(() => {
    const { state } = daemon.supervisor.get(runId)
    return state === "running" || isTerminalRunState(state)
  })
}

async function ended(daemon: Daemon, runId: string) {
  await daemon.supervisor.idle()
  await waitFor(() => daemon.status().pendingUploads === 0)
  return daemon.supervisor.get(runId)
}

function texts(chunks: RunChunk[]) {
  return chunks
    .flatMap((c) => (c.type === "text-delta" ? [c.delta] : []))
    .join("")
}

describe.each(["claude_code", "codex", "cursor"] as const)(
  "%s adapter",
  (harness) => {
    it("hands in through the MCP tool, then the daemon verifies, commits and pushes", async () => {
      const { origin, server, daemon } = await setup()
      const runId = queue(server, harness, "Please SUBMIT")
      await started(daemon, runId)
      const run = await ended(daemon, runId)
      expect(run).toMatchObject({ state: "succeeded", stopReason: "submitted" })
      const completion = server.runs.get(runId)?.completion
      expect(completion?.report).toMatchObject({
        summary: "Wrote NOTES.md",
        filesChanged: ["NOTES.md"],
        verify: { status: "passed" },
      })
      const chunks = server.chunksFor(runId)
      expect(chunks.some((c) => c.type === "tool-input-available")).toBe(true)
      expect(chunks.some((c) => c.type === "tool-output-available")).toBe(true)
      expect(texts(chunks)).not.toBe("")
      const publish = chunks.find((c) => c.type === "data-publish")
      expect(publish).toMatchObject({
        data: { branch: `mikka/run-${runId}`, pushed: true },
      })
      // The completion carries the same result for the orchestrator.
      expect(completion?.report.publish).toEqual(
        publish?.type === "data-publish" ? publish.data : undefined
      )
      const { stdout } = await execa("git", [
        "--git-dir",
        origin,
        "show",
        `mikka/run-${runId}:NOTES.md`,
      ])
      expect(stdout).toBe("notes")
    })

    it("ends as turn_ended, with nothing committed, when the agent never hands in", async () => {
      const { server, daemon } = await setup()
      const runId = queue(server, harness, "just chat")
      await started(daemon, runId)
      expect(await ended(daemon, runId)).toMatchObject({
        state: "stopped",
        stopReason: "turn_ended",
      })
      expect(
        server.chunksFor(runId).some((c) => c.type === "data-publish")
      ).toBe(false)
    })

    // A person's model per harness (ADR 0060) reaches the CLI the run is on:
    // `--model` for Claude Code and Cursor, the `thread/start` param for
    // Codex. The fake CLIs report back what they were started with, so this
    // fails if the assignment's model is dropped on the way.
    it("starts the CLI with the model the assignment named, and with none when it named none", async () => {
      const { server, daemon } = await setup()
      const asked = server.queueRun(DEVICE, {
        issueId: `issue-model-${harness}`,
        repoId: "repo",
        baseBranch: "main",
        harness,
        prompt: "MODEL",
        model: "test-model-1",
        verifyCommand: "test -f NOTES.md",
      })
      await started(daemon, asked)
      await ended(daemon, asked)
      expect(texts(server.chunksFor(asked))).toContain("model: test-model-1")

      // An assignment with no model leaves the CLI on its own default; the
      // daemon must not pass an empty flag.
      const unasked = queue(server, harness, "MODEL")
      await started(daemon, unasked)
      await ended(daemon, unasked)
      expect(texts(server.chunksFor(unasked))).toContain("model: none")
    })
  }
)

describe("the issue branch", () => {
  const PERSON = {
    GIT_AUTHOR_NAME: "Person",
    GIT_AUTHOR_EMAIL: "person@mikka.invalid",
    GIT_COMMITTER_NAME: "Person",
    GIT_COMMITTER_EMAIL: "person@mikka.invalid",
  }

  function queueOnIssue(server: MemoryServer, pushBranch: string) {
    return server.queueRun(DEVICE, {
      issueId: "issue-orv-1",
      repoId: "repo",
      baseBranch: "main",
      harness: "claude_code",
      prompt: "Please SUBMIT",
      verifyCommand: "test -f NOTES.md",
      pushBranch,
    })
  }

  it("builds on the remote branch, keeping a person's commit, and pushes there", async () => {
    const { repo, origin, server, daemon } = await setup()
    await execa("git", ["push", "-q", "origin", "main"], { cwd: repo })
    const person = join(tempDir("orvp-"), "clone")
    await execa("git", ["clone", "-q", origin, person])
    await execa("git", ["checkout", "-q", "-b", "mikka/orv-1"], {
      cwd: person,
    })
    writeFileSync(join(person, "PERSON.md"), "by hand\n")
    await execa("git", ["add", "PERSON.md"], { cwd: person })
    await execa("git", ["commit", "-q", "-m", "person"], {
      cwd: person,
      env: PERSON,
    })
    await execa("git", ["push", "-q", "origin", "mikka/orv-1"], {
      cwd: person,
    })
    const personTip = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: person })
    ).stdout

    const runId = queueOnIssue(server, "mikka/orv-1")
    await started(daemon, runId)
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    const publish = server.runs.get(runId)?.completion?.report.publish
    expect(publish).toMatchObject({
      branch: "mikka/orv-1",
      pushed: true,
      remote: "origin",
    })
    const remote = (...args: string[]) =>
      execa("git", ["--git-dir", origin, ...args]).then((r) => r.stdout)
    expect(await remote("rev-parse", "mikka/orv-1")).toBe(publish?.commit)
    expect(await remote("rev-parse", "mikka/orv-1^")).toBe(personTip)
    const files = await remote("ls-tree", "--name-only", "mikka/orv-1")
    expect(files.split("\n")).toEqual(
      expect.arrayContaining(["NOTES.md", "PERSON.md"])
    )
  })

  it("starts from the base branch when the issue branch cannot be fetched", async () => {
    const { repo, origin, server, daemon } = await setup()
    await execa("git", ["push", "-q", "origin", "main"], { cwd: repo })
    const runId = queueOnIssue(server, "mikka/orv-2")
    await started(daemon, runId)
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    expect(server.runs.get(runId)?.completion?.report.publish).toMatchObject({
      branch: "mikka/orv-2",
      pushed: true,
    })
    const parent = await execa("git", [
      "--git-dir",
      origin,
      "rev-parse",
      "mikka/orv-2^",
    ])
    expect(parent.stdout).toBe(
      (await execa("git", ["rev-parse", "main"], { cwd: repo })).stdout
    )
  })
})

describe("workspace agent policy (ADR 0028)", () => {
  it("keeps a verified run local when the workspace turned pushes off", async () => {
    const { origin, server, daemon } = await setup()
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-policy",
      repoId: "repo",
      baseBranch: "main",
      harness: "claude_code",
      prompt: "Please SUBMIT",
      verifyCommand: "test -f NOTES.md",
      policy: resolveAgentSettings({ permissions: { git_push: "deny" } })
        .policy,
    })
    await started(daemon, runId)
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    expect(
      server.chunksFor(runId).find((c) => c.type === "data-publish")
    ).toMatchObject({
      data: {
        pushed: false,
        note: "Push is turned off for this workspace",
      },
    })
    await expect(
      execa("git", ["--git-dir", origin, "rev-parse", `mikka/run-${runId}`])
    ).rejects.toThrow()
  })

  it("commits and pushes nothing for a read-only check (ADR 0046)", async () => {
    const { origin, server, daemon } = await setup()
    const runId = server.queueRun(DEVICE, {
      issueId: "issue-check",
      repoId: "repo",
      baseBranch: "main",
      harness: "claude_code",
      prompt: "Please SUBMIT",
      verifyCommand: "test -f NOTES.md",
      kind: "acceptance",
      policy: {
        ...resolveAgentSettings({ permissions: { git_push: "allow" } }).policy,
        readOnly: true,
      },
    })
    await started(daemon, runId)
    // The submit is verified, so a normal run would publish here.
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    expect(server.chunksFor(runId).some((c) => c.type === "data-publish")).toBe(
      false
    )
    await expect(
      execa("git", ["--git-dir", origin, "rev-parse", `mikka/run-${runId}`])
    ).rejects.toThrow()
  })
})

describe("verify", () => {
  it("fails a hand-in, and commits nothing, when verify changes the worktree", async () => {
    const { server, daemon } = await setup()
    const runId = queue(
      server,
      "claude_code",
      "Please SUBMIT",
      "test -f NOTES.md && echo patched > NOTES.md"
    )
    await started(daemon, runId)
    const run = await ended(daemon, runId)
    expect(run).toMatchObject({ state: "failed", stopReason: "submitted" })
    expect(run.error).toMatch(/changed the worktree/)
    expect(server.chunksFor(runId).some((c) => c.type === "data-publish")).toBe(
      false
    )
  })
})

describe("interjections and cancel", () => {
  it("claude: a message during the turn reaches the CLI and can lead to a hand-in", async () => {
    const { server, daemon } = await setup()
    const runId = queue(server, "claude_code", "WAIT for me")
    await started(daemon, runId)
    await waitFor(() => texts(server.chunksFor(runId)).includes("waiting"))
    await daemon.supervisor.send(runId, "now SUBMIT")
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    expect(texts(server.chunksFor(runId))).toContain("steered: now SUBMIT")
  })

  it("claude: a hand-in read before the last turn ends keeps that turn's last words", async () => {
    const { server, daemon } = await setup()
    const runId = queue(server, "claude_code", "WAIT for me")
    await started(daemon, runId)
    await waitFor(() => texts(server.chunksFor(runId)).includes("waiting"))
    // The WAIT turn's result is read only after the next turn handed in.
    await daemon.supervisor.send(runId, "LATE: now SUBMIT")
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    expect(texts(server.chunksFor(runId))).toMatch(/now SUBMIThanded in$/)
  })

  it("codex: a message during the turn is a turn/steer", async () => {
    const { server, daemon } = await setup()
    const runId = queue(server, "codex", "WAIT for me")
    await started(daemon, runId)
    await waitFor(() => texts(server.chunksFor(runId)).includes("on it"))
    await daemon.supervisor.send(runId, "now SUBMIT")
    expect(await ended(daemon, runId)).toMatchObject({ state: "succeeded" })
    expect(server.runs.get(runId)?.completion?.report.summary).toBe(
      "Steered and wrote NOTES.md"
    )
  })

  it.each(["claude_code", "cursor"] as const)(
    "%s: cancel stops the CLI and ends the run as cancelled",
    async (harness) => {
      const { server, daemon } = await setup()
      const runId = queue(server, harness, "HANG please")
      await started(daemon, runId)
      await waitFor(() => texts(server.chunksFor(runId)) !== "")
      const run = await daemon.supervisor.cancel(runId)
      expect(run).toMatchObject({ state: "cancelled", stopReason: "cancelled" })
    }
  )
})

// A follow-up run reopens the earlier run's session in the same worktree
// and sends only the follow-up; the brief goes to a new session only when
// that session cannot be reopened.
describe.each(["claude_code", "codex", "cursor"] as const)(
  "%s follow-up run",
  (harness) => {
    const FOLLOW_UP = "FOLLOW the person's message"
    const BRIEF = `BRIEF of the issue\n\n${FOLLOW_UP}`

    async function earlierRun(server: MemoryServer, daemon: Daemon) {
      const runId = queue(server, harness, "just chat")
      await started(daemon, runId)
      return ended(daemon, runId)
    }

    function queueFollowUp(
      server: MemoryServer,
      continuesRunId: string,
      resumeSessionId: string
    ) {
      return server.queueRun(DEVICE, {
        issueId: `issue-${harness}`,
        repoId: "repo",
        baseBranch: "main",
        harness,
        prompt: BRIEF,
        followUp: FOLLOW_UP,
        continuesRunId,
        resumeSessionId,
        verifyCommand: "test -f NOTES.md",
      })
    }

    it("continues the earlier session with only the follow-up", async () => {
      const { server, daemon } = await setup()
      const earlier = await earlierRun(server, daemon)
      const sessionId = earlier.sessionId as string
      const runId = queueFollowUp(server, earlier.runId, sessionId)
      await started(daemon, runId)
      const run = await ended(daemon, runId)
      expect(run).toMatchObject({ sessionId, worktree: earlier.worktree })
      const shown = texts(server.chunksFor(runId))
      expect(shown).toContain(FOLLOW_UP)
      expect(shown).not.toContain("BRIEF")
      if (harness === "claude_code")
        expect(shown).toContain(`resumed ${sessionId}`)
      expect(shown).not.toContain("REPLAYED HISTORY")
    })

    it("starts a new session with the brief when the earlier one is gone", async () => {
      const { server, daemon } = await setup()
      const earlier = await earlierRun(server, daemon)
      const runId = queueFollowUp(server, earlier.runId, "gone-session")
      await started(daemon, runId)
      const run = await ended(daemon, runId)
      expect(run.stopReason).toBe("turn_ended")
      expect(run.sessionId).not.toBe("gone-session")
      expect(run.worktree).toBe(earlier.worktree)
      expect(texts(server.chunksFor(runId))).toContain("BRIEF")
    })
  }
)

describe("resume after a daemon restart", () => {
  it.each(["claude_code", "cursor"] as const)(
    "%s: the next daemon reopens the same session",
    async (harness) => {
      const { server, dataDir, daemon } = await setup()
      const runId = queue(server, harness, "HANG please")
      await started(daemon, runId)
      const sessionId = daemon.supervisor.get(runId).sessionId
      await waitFor(() => texts(server.chunksFor(runId)) !== "")
      await daemon.stop()
      daemons.splice(daemons.indexOf(daemon), 1)

      const second = await boot(server, dataDir)
      const run = await ended(second, runId)
      expect(run.sessionId).toBe(sessionId)
      // The resume message carries no hand-in: the turn just ends.
      expect(run).toMatchObject({ state: "stopped", stopReason: "turn_ended" })
      const shown = texts(server.chunksFor(runId))
      if (harness === "claude_code")
        expect(shown).toContain(`resumed ${sessionId}`)
      // ACP replays history on load; it must not be shown twice.
      expect(shown).not.toContain("REPLAYED HISTORY")
    }
  )

  it("ends at once, without the CLI, when the agent handed in before the restart", async () => {
    const { server, dataDir, daemon } = await setup()
    const runId = queue(server, "claude_code", "HANG please")
    await started(daemon, runId)
    await waitFor(() => texts(server.chunksFor(runId)) !== "")
    const { worktree } = daemon.supervisor.get(runId)
    await daemon.stop()
    daemons.splice(daemons.indexOf(daemon), 1)
    // What the MCP tool would have written just before the daemon died.
    writeFileSync(join(worktree as string, "NOTES.md"), "notes\n")
    writeFileSync(
      join(dataDir, "adapters", "runs", runId, "handoff.json"),
      JSON.stringify({ kind: "submit", summary: "Done before the crash" })
    )

    const second = await boot(server, dataDir)
    const run = await ended(second, runId)
    expect(run).toMatchObject({ state: "succeeded", stopReason: "submitted" })
    expect(server.runs.get(runId)?.completion?.report.summary).toBe(
      "Done before the crash"
    )
    expect(texts(server.chunksFor(runId))).not.toContain("resumed")
  })
})
