import { expect, it, vi } from "vitest"
import type { RunAssignment } from "../server-link"
import { verifyAndPublish, type PublicationDeps } from "./publication"

it.each([true, false])("honors the Factory check's command inference setting (%s)", async (inferCommand) => {
  const assignment: RunAssignment = {
    runId: "run",
    deviceId: "device",
    repoId: "repo",
    issueId: "issue",
    prompt: "Verify the delivery",
    harness: "mock",
    factoryCheck: { stage: "verify", inferCommand, reportOnly: false },
  }
  const signal = new AbortController().signal
  const verify = vi.fn<NonNullable<PublicationDeps["verify"]>>(async () => ({
    exitCode: 0, signal: null, timedOut: false, output: "checks passed",
  }))
  const publish = vi.fn<NonNullable<PublicationDeps["publisher"]>["publish"]>(async () => ({
    branch: "mikka/issue", commit: "a".repeat(40), pushed: false, remote: null,
  }))
  const result = await verifyAndPublish({
    deps: {
      journal: { get: () => undefined, update: vi.fn() },
      worktrees: { changedFiles: async () => ["package.json"] },
      verify,
      publisher: { snapshot: async () => "verified-tree", publish },
    },
    runId: assignment.runId,
    assignment,
    repo: { repoId: "repo", name: "fixture", path: "/repo" },
    worktree: "/worktree",
    signal,
    assertLive: () => signal.throwIfAborted(),
    githubEnvironment: () => undefined,
    getStopReason: () => "submitted",
    isStopping: () => false,
    isCancelled: () => false,
    logPublishError: vi.fn(),
    emitPublish: vi.fn(),
  }, {
    type: "exit",
    outcome: "succeeded",
    report: { verificationCommand: { command: "pnpm test", basis: "package.json test script" } },
  })

  if (inferCommand) {
    expect(verify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: "pnpm test" }))
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tree: "verified-tree" }))
    expect(result?.report).toMatchObject({
      filesChanged: ["package.json"],
      verify: { status: "passed", command: "pnpm test", inferredFrom: "package.json test script" },
      publish: { commit: "a".repeat(40) },
    })
  } else {
    expect(verify).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(result?.report.verify).toEqual({ status: "not_run" })
  }
})
