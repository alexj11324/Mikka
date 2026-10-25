// Layered evidence: real daemon, git and child processes; explicitly simulated Harness.
// This suite cannot replace CC/Codex + sandbox + Preview acceptance.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execa } from "execa"
import { afterEach, expect, it } from "vitest"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { fixedCheckSnapshot } from "../src/runs/check"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const daemons: Daemon[] = []
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  cleanupTempDirs()
})
const policy = {
  readOnly: true,
  permissions: {
    install_dependency: "deny",
    write_outside_repo: "deny",
    git_push: "deny",
    network: "ask",
  },
  networkAllow: [],
} as const

it("checks real SHA, blocks dirty/head replacement, and produces actual command/exit evidence across fresh mock sessions", async () => {
  const repo = await makeRepo()
  const git = async (...args: string[]) =>
    (
      await execa("git", args, {
        cwd: repo,
        env: {
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@mikka.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@mikka.invalid",
        },
      })
    ).stdout.trim()
  writeFileSync(
    join(repo, "acceptance.mjs"),
    "console.error('REAL_ASSERTION_FAILURE expected 2 received 1'); process.exit(17)\n"
  )
  await git("add", "acceptance.mjs")
  await git("commit", "-m", "Introduce intentional real test fault")
  const sha1 = await git("rev-parse", "HEAD")
  const server = new MemoryServer("fixture-device")
  server.addRepo("fixture-device", {
    repoId: "fixture-repo",
    path: repo,
    name: "check fixture",
    setup: {
      approved: true,
      copyFiles: [],
      command: "touch SETUP_MUST_NOT_RUN",
    },
  })
  const dataDir = tempDir()
  const daemon = await new Daemon({
    dataDir,
    flavor: "dev",
    link: server.link(),
    credential: "fixture-credential",
    harnesses: [{ harness: "mock", installed: true, version: "fixture" }],
    mockSpeed: Infinity,
    quotaSource: null,
    heartbeatMs: 50,
  }).start()
  daemons.push(daemon)
  const check = async (sha: string) => {
    const runId = server.queueRun("fixture-device", {
      issueId: "fixture-issue",
      repoId: "fixture-repo",
      baseBranch: sha,
      harness: "mock",
      kind: "check",
      fixture: "check-pass",
      prompt: "Explicit simulated independent check",
      verifyCommand: "node acceptance.mjs",
      policy: { ...policy, networkAllow: [] },
    })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId)?.stopReason)
    await daemon.supervisor.idle()
    await waitFor(() => server.runs.get(runId)?.completion)
    const run = daemon.supervisor.get(runId)
    const completion = server.runs.get(runId)!.completion!
    return { runId, run, completion }
  }
  const first = await check(sha1)
  expect(first.run.state).toBe("failed")
  expect(first.completion.report.verify).toMatchObject({
    status: "failed",
    command: "node acceptance.mjs",
    exitCode: 17,
    signal: null,
    timedOut: false,
  })
  expect(first.completion.report.verify.output).toContain(
    "REAL_ASSERTION_FAILURE"
  )
  expect(first.completion.report.check).toEqual({ sha: sha1, readOnly: true })
  expect(first.completion.report.publish).toBeUndefined()
  expect(readFileSync(join(repo, "acceptance.mjs"), "utf8")).toContain(
    "process.exit(17)"
  )
  writeFileSync(
    join(repo, "acceptance.mjs"),
    "console.log('REAL_ACCEPTANCE_PASS 2 === 2')\n"
  )
  await git("add", "acceptance.mjs")
  await git("commit", "-m", "Repair intentional real test fault")
  const sha2 = await git("rev-parse", "HEAD")
  const review = await check(sha2),
    verify = await check(sha2)
  expect(sha1).not.toBe(sha2)
  expect(
    new Set([first.run.sessionId, review.run.sessionId, verify.run.sessionId])
      .size
  ).toBe(3)
  for (const result of [review, verify]) {
    expect(result.run.state).toBe("succeeded")
    expect(result.completion.report.check).toEqual({
      sha: sha2,
      readOnly: true,
    })
    expect(result.completion.report.verify).toMatchObject({
      status: "passed",
      exitCode: 0,
    })
    expect(result.completion.report.verify.output).toContain(
      "REAL_ACCEPTANCE_PASS"
    )
    const worktree = result.run.worktree!
    await expect(fixedCheckSnapshot(repo, worktree, sha1)).rejects.toThrow(
      /HEAD differs/
    )
    writeFileSync(join(worktree, "tampered"), "tampered\n")
    await expect(fixedCheckSnapshot(repo, worktree, sha2)).rejects.toThrow(
      /contains changes/
    )
  }
  if (process.env.FACTORY_EVIDENCE_OUT) {
    mkdirSync(process.env.FACTORY_EVIDENCE_OUT, { recursive: true })
    writeFileSync(
      join(
        process.env.FACTORY_EVIDENCE_OUT,
        "daemon-real-command-mock-harness.json"
      ),
      JSON.stringify(
        {
          layer:
            "real daemon/git/commands; simulated Harness; sandbox unsupported",
          sha1,
          sha2,
          first,
          review,
          verify,
        },
        null,
        2
      )
    )
  }
})
