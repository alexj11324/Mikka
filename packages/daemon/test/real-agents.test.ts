// End-to-end runs with the real, signed-in CLIs on this machine: the daemon
// claims a run, creates the worktree, drives the CLI inside sandbox-runtime,
// the agent hands in through Mikka's MCP tool, the daemon verifies,
// commits and pushes the run branch to the repo's remote. Uses the user's
// subscription, so it only runs when asked:
//
//   MIKKA_REAL_AGENTS=claude_code,codex,cursor bunx vitest run test/real-agents.test.ts
//
// Transcripts (the run's chunks) are written to MIKKA_REAL_AGENTS_OUT when set.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { execa } from "execa"
import { afterAll, describe, expect, it } from "vitest"

import { ToolApprovalGate } from "../src/agents/tool-approval"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const HARNESSES = (process.env.MIKKA_REAL_AGENTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean) as ("claude_code" | "codex" | "cursor")[]
const OUT = process.env.MIKKA_REAL_AGENTS_OUT
const DEVICE = "device-real"
const daemons: Daemon[] = []

afterAll(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

const VERIFY =
  "node --input-type=module -e \"import { greet } from './src/greet.mjs'; if (greet('Ada') !== 'Hello, Ada!') process.exit(1)\""

async function setup() {
  const repo = await makeRepo()
  const origin = tempDir("orvo-")
  await execa("git", ["init", "-q", "--bare", origin])
  await execa("git", ["remote", "add", "origin", origin], { cwd: repo })
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, {
    repoId: "repo-real",
    name: "sandbox",
    path: repo,
    push: { approved: true },
  })
  const dataDir = tempDir()
  const daemon = await boot(server, dataDir)
  return { repo, origin, server, daemon, dataDir }
}

async function boot(server: MemoryServer, dataDir: string) {
  // The HTTP link supplies this gate in production; this run allows every tool.
  const link = server.link()
  link.prepareRunToolApproval = async assignment => new ToolApprovalGate(assignment.runId, { permission: () => 'allow', ask: async () => 'deny', isLive: () => true })
  const daemon = await new Daemon({
    dataDir,
    flavor: "dev",
    link,
    credential: "cred-real",
    heartbeatMs: 1000,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return daemon
}

function save(name: string, value: unknown) {
  if (!OUT) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(value, null, 2))
}

// The half of a planning run no mock can stand in for (ADR ORV-205): whether a
// real CLI, given `planInstructions()` and the `mikka` submit tool, really
// hands in a spec and a split — and really writes no code while doing it.
// The mock replays a report verbatim, so it never exercises the tool's
// nested `spec` / `split` arguments or the agent's choice to use them.
describe.skipIf(HARNESSES.length === 0)(
  "real agent CLIs on a planning run",
  () => {
    for (const harness of HARNESSES) {
      it(
        `${harness}: hands in a spec and a split, and changes no file`,
        async () => {
          const { server, daemon } = await setup()
          const runId = server.queueRun(DEVICE, {
            issueId: `issue-plan-${harness}`,
            repoId: "repo-real",
            baseBranch: "main",
            harness,
            kind: "plan",
            // The brief `runPrompt()` builds for a plan run: the title and the
            // goal, and no criteria — writing them is what the run is for.
            // The goal settles the product decisions a planner would otherwise
            // have to ask about, which is the other correct ending (ADR ORV-205)
            // and a different test: this one is about the spec and the split.
            prompt: [
              "Copy an issue's link from its page",
              "",
              'A member opens an issue and clicks a button beside the title; the issue\'s link goes to the clipboard and the button reads "Copied" for two seconds.',
              "",
              'Every product decision is settled, so there is nothing to ask a person: the link is the issue\'s own URL, there is no share sheet, the button sits to the right of the title and is always visible, and a copy that fails shows "Could not copy".',
              "This checkout is a scratch repository with no product code in it: plan the work against it as it is, naming the files the work would add.",
              "Write the spec and the split now and hand them in.",
            ].join("\n"),
          })
          await daemon.syncWithServer()
          await waitFor(() =>
            daemon.supervisor.list().find((r) => r.runId === runId)
          )
          await daemon.supervisor.idle()
          await waitFor(() => daemon.status().pendingUploads === 0, 30_000)

          const chunks = server.chunksFor(runId)
          const run = daemon.supervisor.get(runId)
          const completion = server.runs.get(runId)?.completion
          save(`${harness}-plan`, { run, completion, chunks })

          expect(run.error ?? null).toBeNull()
          expect(run.state).toBe("succeeded")
          expect(run.stopReason).toBe("submitted")

          // The two cards a person approves, straight out of the CLI's hand-in.
          const spec = chunks.find((c) => c.type === "data-spec")
          const split = chunks.find((c) => c.type === "data-split")
          expect(spec?.type).toBe("data-spec")
          expect(split?.type).toBe("data-split")
          if (spec?.type !== "data-spec" || split?.type !== "data-split")
            throw new Error("no planning cards in the run's transcript")
          expect(spec.data.specId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
          )
          expect(spec.data.title.length).toBeGreaterThan(0)
          expect(spec.data.sections.length).toBeGreaterThan(0)
          expect(spec.data.sections.every((s) => s.items.length > 0)).toBe(true)
          // Both cards name the one spec row the person approves.
          expect(split.data.specId).toBe(spec.data.specId)
          expect(split.data.issues.length).toBeGreaterThan(0)
          // Every issue can be said to be done, or it is not a usable split.
          expect(split.data.issues.every((i) => i.criteria.length > 0)).toBe(
            true
          )
          expect(
            split.data.issues.every(
              (i) => i.key.length > 0 && i.title.length > 0
            )
          ).toBe(true)
          // Blockers name keys of the same plan, the way `planSplitProblem` reads it.
          const keys = new Set(split.data.issues.map((i) => i.key))
          for (const issue of split.data.issues)
            for (const blocker of issue.blockedBy)
              expect(keys.has(blocker)).toBe(true)

          // A planning run writes no code: nothing changed, nothing was
          // committed or pushed, and the issue's verify never ran.
          expect(completion?.report.filesChanged).toEqual([])
          expect(completion?.report.verify.status).toBe("not_run")
          expect(chunks.some((c) => c.type === "data-publish")).toBe(false)
          expect(completion?.report.plan?.specId).toBe(spec.data.specId)
          expect(
            await execa("git", ["status", "--porcelain"], {
              cwd: run.worktree as string,
            }).then((r) => r.stdout)
          ).toBe("")
        },
        15 * 60_000
      )
    }
  }
)

describe.skipIf(HARNESSES.length === 0)("real agent CLIs", () => {
  for (const harness of HARNESSES) {
    it(
      `${harness}: edits in a sandboxed worktree, hands in, gets committed and pushed`,
      async () => {
        const { repo, server, daemon } = await setup()
        expect(daemon.status().harnesses.map((h) => h.harness)).toContain(
          harness
        )
        const runId = server.queueRun(DEVICE, {
          issueId: `issue-${harness}`,
          repoId: "repo-real",
          baseBranch: "main",
          harness,
          prompt: [
            "Create `src/greet.mjs` exporting `function greet(name)` that returns `Hello, <name>!` (for example greet('Ada') returns 'Hello, Ada!').",
            "Also try once to create the file `/tmp/mikka-escape-test.txt`; it is expected to fail, just mention the result in your summary.",
            "Then hand in your work with the mikka submit tool.",
          ].join("\n"),
          verifyCommand: VERIFY,
        })
        await daemon.syncWithServer()
        await waitFor(() =>
          daemon.supervisor.list().find((r) => r.runId === runId)
        )
        await daemon.supervisor.idle()
        await waitFor(() => daemon.status().pendingUploads === 0, 30_000)

        const chunks = server.chunksFor(runId)
        const run = daemon.supervisor.get(runId)
        save(harness, {
          run,
          completion: server.runs.get(runId)?.completion,
          chunks,
        })
        expect(run.error ?? null).toBeNull()
        expect(run.state).toBe("succeeded")
        expect(run.stopReason).toBe("submitted")
        const completion = server.runs.get(runId)?.completion
        expect(completion?.report.verify.status).toBe("passed")
        expect(completion?.report.filesChanged).toContain("src/greet.mjs")
        expect(chunks.some((c) => c.type === "tool-input-available")).toBe(true)

        const publish = chunks.find((c) => c.type === "data-publish")
        expect(publish?.type === "data-publish" && publish.data).toMatchObject({
          branch: `mikka/run-${runId}`,
          pushed: true,
        })
        // The branch really is on the remote, with the agent's file.
        // The cached clone's remote is the source repository.
        const { stdout } = await execa("git", [
          "--git-dir",
          join(repo, ".git"),
          "show",
          `mikka/run-${runId}:src/greet.mjs`,
        ])
        expect(stdout).toMatch(/greet/)
        // The sandbox kept the agent out of /tmp.
        expect(() =>
          readFileSync("/tmp/mikka-escape-test.txt", "utf8")
        ).toThrow()
      },
      15 * 60_000
    )

    it(
      `${harness}: survives a daemon restart and resumes the same session`,
      async () => {
        const { server, daemon, dataDir } = await setup()
        const runId = server.queueRun(DEVICE, {
          issueId: `issue-resume-${harness}`,
          repoId: "repo-real",
          baseBranch: "main",
          harness,
          prompt: [
            "First run the shell command `sleep 20 && echo waited` in the foreground and wait for it to finish.",
            "Then create `src/greet.mjs` exporting `function greet(name)` that returns `Hello, <name>!`.",
            "Then hand in your work with the mikka submit tool.",
          ].join("\n"),
          verifyCommand: VERIFY,
        })
        await daemon.syncWithServer()
        await waitFor(
          () =>
            server
              .chunksFor(runId)
              .some((c) => c.type === "tool-input-available"),
          5 * 60_000,
          500
        )
        const sessionId = daemon.supervisor.get(runId).sessionId
        await daemon.stop()
        daemons.splice(daemons.indexOf(daemon), 1)

        const second = await boot(server, dataDir)
        await waitFor(
          () => second.supervisor.activeRunIds().includes(runId),
          30_000,
          200
        )
        await second.supervisor.idle()
        await waitFor(() => second.status().pendingUploads === 0, 30_000)
        const run = second.supervisor.get(runId)
        save(`${harness}-resume`, {
          run,
          sessionBefore: sessionId,
          completion: server.runs.get(runId)?.completion,
          chunks: server.chunksFor(runId),
        })
        expect(run.sessionId).toBe(sessionId)
        expect(run.error ?? null).toBeNull()
        expect(run).toMatchObject({
          state: "succeeded",
          stopReason: "submitted",
        })
      },
      15 * 60_000
    )
  }
})
