// The pieces real adapters share: Mikka's MCP hand-in server, the run
// context's handoff file, and the daemon's commit and push of a verified run.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { execa } from "execa"
import { afterEach, describe, expect, it } from "vitest"

import { defaultRunPolicy, PACKAGE_REGISTRY_DOMAINS } from "@mikka/protocol/agent-policy"

import { onLines } from "../src/agents/child"
import { commitMessage, publishRun, snapshotTree } from "../src/agents/publish"
import { MCP_SERVER_SCRIPT, RunContext } from "../src/agents/run-context"
import type { Logger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(() => cleanupTempDirs())

async function worktreeOf(repo: string) {
  const path = join(tempDir("orvw-"), "wt")
  await execa("git", ["worktree", "add", "-q", "-b", "mikka/run-t", path], {
    cwd: repo,
  })
  return path
}

/** Talks newline-delimited JSON-RPC to the MCP server script. */
function mcpClient(handoff: string) {
  const child = spawn(process.execPath, [
    MCP_SERVER_SCRIPT,
    "--handoff",
    handoff,
  ])
  const waiting = new Map<number, (value: unknown) => void>()
  onLines(child.stdout, (line) => {
    const message = JSON.parse(line) as { id: number }
    waiting.get(message.id)?.(message)
  })
  let id = 0
  return {
    request(method: string, params?: unknown) {
      const current = ++id
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`,
      )
      return new Promise<Record<string, unknown>>((resolve) =>
        waiting.set(current, resolve as (value: unknown) => void),
      )
    },
    close: () => child.kill(),
  }
}

describe("mikka MCP server", () => {
  it("lists the hand-in tools and records a submit as the session's exit", async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({
      harness: "claude_code",
      worktree: await worktreeOf(repo),
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
    })
    const client = mcpClient(ctx.handoffFile)
    try {
      const init = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
      expect(init).toMatchObject({
        result: { serverInfo: { name: "mikka" } },
      })
      const list = (await client.request("tools/list")) as {
        result: { tools: { name: string }[] }
      }
      expect(list.result.tools.map((t) => t.name)).toEqual([
        "submit",
        "request_help",
        "ask_human",
        "report_blocked",
      ])
      expect(ctx.readHandoff()).toBeNull()
      await client.request("tools/call", {
        name: "submit",
        arguments: { summary: "Added greet()", nextStep: "Review it" },
      })
      expect(ctx.readHandoff()).toEqual({
        type: "exit",
        outcome: "succeeded",
        stopReason: "submitted",
        report: {
          summary: "Added greet()",
          nextStep: "Review it",
          openQuestions: [],
        },
      })
      // The handoff lives in the run dir, never in the tree.
      expect(ctx.handoffFile.startsWith(ctx.runDir)).toBe(true)
      ctx.clearHandoff()
      expect(ctx.readHandoff()).toBeNull()

      // A read-only check hands in one verdict per criterion (ADR 0046).
      const criterionId = randomUUID()
      await client.request("tools/call", {
        name: "submit",
        arguments: {
          summary: "Checked AC-1",
          previewDatabaseBranch: "preview/ac-1",
          criteria: [
            {
              criterionId,
              passed: true,
              evidence: "curl -s localhost:4000 -> 200",
              command: "curl -fsS localhost:4000",
              exitCode: 0,
            },
          ],
        },
      })
      expect(ctx.readHandoff()).toMatchObject({
        stopReason: "submitted",
        report: {
          previewDatabaseBranch: "preview/ac-1",
          criteria: [
            {
              criterionId,
              passed: true,
              evidence: "curl -s localhost:4000 -> 200",
              command: "curl -fsS localhost:4000",
              exitCode: 0,
            },
          ],
        },
      })
      ctx.clearHandoff()

      await client.request("tools/call", {
        name: "report_blocked",
        arguments: { blockedOn: "quota_exhausted" },
      })
      expect(ctx.readHandoff()).toMatchObject({
        outcome: "failed",
        stopReason: "blocked",
        report: { blockedOn: "quota_exhausted" },
      })
      await client.request("tools/call", {
        name: "ask_human",
        arguments: { question: "Which color?" },
      })
      expect(ctx.readHandoff()).toMatchObject({
        stopReason: "asked_human",
        report: { openQuestions: ["Which color?"] },
      })
      const questionId = ctx.readHandoff()?.report?.question?.questionId
      expect(questionId).toEqual(expect.any(String))
      await client.request("tools/call", {
        name: "ask_human",
        arguments: { question: "Which color?" },
      })
      expect(ctx.readHandoff()?.report?.question?.questionId).toBe(questionId)
      ctx.clearHandoff()
      await client.request("tools/call", {
        name: "request_help",
        arguments: { question: "Which existing API should I use?" },
      })
      expect(ctx.readHandoff()?.report?.question).toMatchObject({
        kind: "context",
        question: "Which existing API should I use?",
      })
      const unknown = await client.request("tools/call", { name: "rm_rf" })
      expect(unknown).toHaveProperty("error")
    } finally {
      client.close()
    }
  })
})

describe("run context", () => {
  it("lets the run write its worktree and run dir, never git's files, and always reach its harness API", async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({
      harness: "codex",
      worktree: await worktreeOf(repo),
      networkAllow: ["registry.npmjs.org"],
      extraWrite: ["/tmp/codex-auth.json"],
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
      // A person limited the network; the run still reaches its harness API.
      policy: { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, network: "ask" } },
    })
    const policy = ctx.policy()
    expect(policy).toMatchObject({
      allowWrite: [ctx.worktree, ctx.runDir, "/tmp/codex-auth.json"],
      denyWrite: [
        join(ctx.worktree, ".git"),
        join(ctx.gitDir, "commondir"),
        join(ctx.gitDir, "gitdir"),
        join(ctx.gitDir, "config.worktree"),
      ],
      allowDomains: [
        "openai.com",
        "*.openai.com",
        "chatgpt.com",
        "*.chatgpt.com",
        // The workspace's default allow-list (ADR 0028), then the repo's.
        "github.com",
        "*.github.com",
        "*.githubusercontent.com",
        ...PACKAGE_REGISTRY_DOMAINS,
      ],
    })
    expect(policy.allowWrite).not.toContain(ctx.gitDir)
    const home = homedir()
    expect(policy.denyRead).toEqual(
      expect.arrayContaining([
        join(home, ".ssh"),
        join(home, ".aws"),
        join(home, ".claude/.credentials.json"),
      ]),
    )
    // Codex still reads its own login; the others never see it.
    expect(policy.denyRead).not.toContain(join(home, ".codex/auth.json"))
  })

  it("a read-only check can read its worktree but not write it (ADR 0046)", async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({
      harness: "codex",
      worktree: await worktreeOf(repo),
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
      policy: { ...defaultRunPolicy(), readOnly: true },
    })
    const policy = ctx.policy()
    // The worktree moves out of the writable set and into the denied one;
    // the run dir stays writable so the handoff still lands.
    expect(policy.allowWrite).not.toContain(ctx.worktree)
    expect(policy.allowWrite).toEqual([ctx.runDir])
    expect(policy.denyWrite).toEqual(
      expect.arrayContaining([ctx.worktree, join(ctx.worktree, ".git")]),
    )
    // Its instructions say so, so the agent does not try.
    expect(ctx.instructions()).toContain("read-only check")
  })
})

describe("publish", () => {
  async function repoWithRemote() {
    const repo = await makeRepo()
    const origin = tempDir("orvo-")
    await execa("git", ["init", "-q", "--bare", origin])
    await execa("git", ["remote", "add", "origin", origin], { cwd: repo })
    return { repo, origin }
  }

  async function runWorktree(repo: string, runId: string) {
    const worktree = join(tempDir("orvw-"), runId)
    await execa(
      "git",
      ["worktree", "add", "-q", "-b", `mikka/run-${runId}`, worktree],
      { cwd: repo },
    )
    return worktree
  }

  async function snapshotAndPublish(
    repo: string,
    worktree: string,
    options: { runId: string; summary: string; approved: boolean },
  ) {
    const tree = await snapshotTree(repo, worktree)
    return publishRun({
      runId: options.runId,
      repoPath: repo,
      worktree,
      tree,
      issueId: "issue-1",
      summary: options.summary,
      push: { approved: options.approved, remote: "origin" },
    })
  }

  it("commits the snapshot on the run branch and pushes it when approved", async () => {
    const { repo, origin } = await repoWithRemote()
    const worktree = await runWorktree(repo, "run-1")
    writeFileSync(join(worktree, "NEW.md"), "new\n")
    const tree = await snapshotTree(repo, worktree)
    // Written after the snapshot: not part of what verify passed on.
    writeFileSync(join(worktree, "LATE.md"), "late\n")
    const result = await publishRun({
      runId: "run-1",
      repoPath: repo,
      worktree,
      tree,
      issueId: "issue-1",
      summary: "Add NEW.md\n\nBecause it was asked for.",
      push: { approved: true, remote: "origin" },
    })
    expect(result).toMatchObject({
      branch: "mikka/run-run-1",
      pushed: true,
      remote: "origin",
    })
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
    const remote = (args: string[]) =>
      execa("git", ["--git-dir", origin, ...args]).then((r) => r.stdout)
    const log = await remote([
      "log",
      "-1",
      "--format=%s%n%b",
      "mikka/run-run-1",
    ])
    expect(log).toContain("mikka: Add NEW.md")
    expect(log).toContain("Mikka-Run: run-1")
    const files = await remote(["ls-tree", "--name-only", "mikka/run-run-1"])
    expect(files.split("\n")).toContain("NEW.md")
    expect(files.split("\n")).not.toContain("LATE.md")
    // The worktree's own branch moved to the commit.
    const head = await execa("git", ["rev-parse", "HEAD"], { cwd: worktree })
    expect(head.stdout).toBe(result.commit)
  })

  it("ignores a .git file the agent pointed at another repo", async () => {
    const { repo } = await repoWithRemote()
    const worktree = await runWorktree(repo, "run-3")
    writeFileSync(join(worktree, "NEW.md"), "new\n")
    // A repo of the agent's making, with a hook that would run on commit.
    const evil = await makeRepo()
    const marker = join(tempDir("orvm-"), "ran")
    const hooks = join(evil, ".git", "hooks")
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    })
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(evil, ".git")}\n`)
    const evilHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: evil }))
      .stdout
    const result = await snapshotAndPublish(repo, worktree, {
      runId: "run-3",
      summary: "x",
      approved: false,
    })
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
    const branch = await execa(
      "git",
      ["rev-parse", "refs/heads/mikka/run-run-3"],
      { cwd: repo },
    )
    expect(branch.stdout).toBe(result.commit)
    expect(
      (await execa("git", ["rev-parse", "HEAD"], { cwd: evil })).stdout,
    ).toBe(evilHead)
    expect(existsSync(marker)).toBe(false)
  })

  it("commits but does not push without approval, and skips an empty run", async () => {
    const { repo, origin } = await repoWithRemote()
    const worktree = await runWorktree(repo, "run-2")
    const empty = await snapshotAndPublish(repo, worktree, {
      runId: "run-2",
      summary: "nothing",
      approved: true,
    })
    expect(empty).toMatchObject({
      commit: null,
      pushed: false,
      skipped: "no_changes",
    })
    writeFileSync(join(worktree, "x.txt"), "x\n")
    const held = await snapshotAndPublish(repo, worktree, {
      runId: "run-2",
      summary: "x",
      approved: false,
    })
    expect(held.commit).not.toBeNull()
    expect(held).toMatchObject({
      branch: "mikka/run-run-2",
      pushed: false,
      remote: null,
      skipped: "not_approved",
      note: /approval/,
    })
    const remote = await execa(
      "git",
      ["--git-dir", origin, "branch", "--list"],
      { reject: false },
    )
    expect(remote.stdout.trim()).toBe("")
  })

  describe("to the issue branch", () => {
    const PERSON = {
      GIT_AUTHOR_NAME: "Person",
      GIT_AUTHOR_EMAIL: "person@mikka.invalid",
      GIT_COMMITTER_NAME: "Person",
      GIT_COMMITTER_EMAIL: "person@mikka.invalid",
    }
    const remoteRev = (origin: string, ref: string) =>
      execa("git", ["--git-dir", origin, "rev-parse", ref], {
        reject: false,
      }).then((r) => (r.exitCode === 0 ? r.stdout.trim() : null))

    async function publishTo(
      repo: string,
      worktree: string,
      runId: string,
      approved = true,
      pushBranch = "mikka/orv-1",
    ) {
      return publishRun({
        runId,
        repoPath: repo,
        worktree,
        tree: await snapshotTree(repo, worktree),
        issueId: "issue-1",
        summary: `Work of ${runId}`,
        pushBranch,
        baseBranch: "main",
        push: { approved, remote: "origin" },
      })
    }

    /** What a continued run does to the worktree: same tree, its own branch. */
    const continueAs = (worktree: string, runId: string) =>
      execa("git", ["checkout", "-q", "-b", `mikka/run-${runId}`], {
        cwd: worktree,
      })

    it("pushes each run's commit to the same branch, fast-forward", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const first = await publishTo(repo, worktree, "run-1")
      expect(first).toMatchObject({
        branch: "mikka/orv-1",
        pushed: true,
        remote: "origin",
      })
      expect(first.skipped).toBeUndefined()
      expect(await remoteRev(origin, "mikka/orv-1")).toBe(first.commit)
      // The local commit stays on the run's own branch, which is not pushed.
      expect(
        (await execa("git", ["rev-parse", "mikka/run-run-1"], { cwd: repo }))
          .stdout,
      ).toBe(first.commit)
      expect(await remoteRev(origin, "mikka/run-run-1")).toBeNull()

      await continueAs(worktree, "run-2")
      writeFileSync(join(worktree, "two.txt"), "2\n")
      const second = await publishTo(repo, worktree, "run-2")
      expect(second).toMatchObject({ branch: "mikka/orv-1", pushed: true })
      expect(await remoteRev(origin, "mikka/orv-1")).toBe(second.commit)
      expect(await remoteRev(origin, "mikka/orv-1^")).toBe(first.commit)

      // A run that changes nothing re-pushes the issue's head (a no-op).
      await continueAs(worktree, "run-3")
      const third = await publishTo(repo, worktree, "run-3")
      expect(third).toEqual({
        branch: "mikka/orv-1",
        commit: second.commit,
        pushed: true,
        remote: "origin",
        skipped: "no_changes",
      })
    })

    it("pushes nothing when the worktree is still the base branch", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      expect(await publishTo(repo, worktree, "run-1")).toMatchObject({
        branch: "mikka/run-run-1",
        commit: null,
        pushed: false,
        skipped: "no_changes",
      })
      expect(await remoteRev(origin, "mikka/orv-1")).toBeNull()
    })

    it("commits without pushing when push is not approved", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const result = await publishTo(repo, worktree, "run-1", false)
      expect(result).toMatchObject({
        branch: "mikka/run-run-1",
        pushed: false,
        remote: null,
        skipped: "not_approved",
      })
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(await remoteRev(origin, "mikka/orv-1")).toBeNull()
    })

    it("never forces over commits it does not have, and reports the failure", async () => {
      const { repo, origin } = await repoWithRemote()
      // Someone else's history on the issue branch.
      const other = await makeRepo()
      await execa("git", ["commit", "-q", "--allow-empty", "-m", "theirs"], {
        cwd: other,
        env: PERSON,
      })
      await execa(
        "git",
        ["push", "-q", origin, "main:refs/heads/mikka/orv-1"],
        {
          cwd: other,
        },
      )
      const theirs = await remoteRev(origin, "mikka/orv-1")
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const result = await publishTo(repo, worktree, "run-1")
      expect(result).toMatchObject({
        branch: "mikka/orv-1",
        pushed: false,
        remote: "origin",
        note: /Push failed/,
      })
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(result.skipped).toBeUndefined()
      expect(await remoteRev(origin, "mikka/orv-1")).toBe(theirs)
    })

    it("refuses a branch name that is not a plain branch", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const result = await publishTo(repo, worktree, "run-1", true, "a..b")
      expect(result).toMatchObject({ pushed: false, note: /branch name/ })
      expect(result.skipped).toBeUndefined()
      const branches = await execa("git", ["--git-dir", origin, "branch"])
      expect(branches.stdout.trim()).toBe("")
    })
  })

  it("builds a commit message from the agent's summary", () => {
    expect(
      commitMessage({ runId: "r", issueId: "i", summary: "  Fix bug  " }),
    ).toBe("mikka: Fix bug\n\nMikka-Run: r\nMikka-Issue: i")
  })
})

describe("the planning hand-in (ADR ORV-205)", () => {
  const spec = {
    title: "Planner",
    summary: "What changes for the user.",
    sections: [
      { heading: "User stories", items: ["As a person, I want a spec."] },
    ],
  }
  const split = {
    summary: "",
    issues: [
      {
        key: "scaffold",
        title: "Scaffold the schema",
        blockedBy: [],
        criteria: [{ body: "The table exists." }],
        predictedFiles: ["packages/db/src/schema/work.ts"],
        priority: "high",
      },
    ],
  }

  async function planContext(kind?: "plan") {
    return new RunContext({
      harness: "claude_code",
      ...(kind ? { kind } : {}),
      worktree: await worktreeOf(await makeRepo()),
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
    })
  }

  async function submit(ctx: RunContext, args: Record<string, unknown>) {
    const client = mcpClient(ctx.handoffFile)
    try {
      await client.request("initialize", { protocolVersion: "2025-06-18" })
      return await client.request("tools/call", {
        name: "submit",
        arguments: args,
      })
    } finally {
      client.close()
    }
  }

  it("records the spec and the split, and reads them back as the run's plan", async () => {
    const ctx = await planContext("plan")
    const result = await submit(ctx, {
      summary: "Wrote the spec.",
      spec,
      split,
    })
    // The agent is told what happens next, not that its work was verified.
    expect(result).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("approves the spec") }],
      },
    })
    const plan = ctx.readHandoff()?.report?.plan
    expect(plan?.specId).toMatch(/^[0-9a-f-]{36}$/)
    expect(plan?.spec.title).toBe("Planner")
    expect(plan?.split.issues[0]).toMatchObject({
      key: "scaffold",
      blockedBy: [],
      criteria: [{ body: "The table exists." }],
    })
  })

  it("drops a split that cannot be built, so no broken plan is stored", async () => {
    const ctx = await planContext("plan")
    await submit(ctx, {
      summary: "Wrote the spec.",
      spec,
      split: {
        summary: "",
        issues: [{ ...split.issues[0]!, blockedBy: ["nope"] }],
      },
    })
    const report = ctx.readHandoff()?.report
    // The submit still ends the run; only the unbuildable plan is left out.
    expect(report?.summary).toBe("Wrote the spec.")
    expect(report?.plan).toBeUndefined()
  })

  it("drops a hand-in with no spec at all", async () => {
    const ctx = await planContext("plan")
    await submit(ctx, { summary: "Wrote the spec.", split })
    expect(ctx.readHandoff()?.report?.plan).toBeUndefined()
  })

  it("tells a plan run to write a spec, and other runs nothing about specs", async () => {
    const planning = await planContext("plan")
    expect(planning.instructions()).toContain("This is a planning run")
    const implementing = await planContext()
    expect(implementing.instructions()).not.toContain("This is a planning run")
  })
})
