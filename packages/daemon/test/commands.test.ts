// Messages and stops from people reach running agents (ADR 0018): the
// daemon long-polls the server's commands, hands messages to the session,
// acks them, and cancels runs a person stopped.
import { afterEach, describe, expect, it } from "vitest"

import type { RunChunk } from "../src/chunks"
import { Daemon } from "../src/main"
import { MemoryServer } from "../src/server-link"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const DEVICE = "device-1"
const daemons: Daemon[] = []

async function setup() {
  const repo = await makeRepo()
  const server = new MemoryServer(DEVICE)
  server.addRepo(DEVICE, { repoId: "repo-1", name: "sandbox", path: repo })
  const daemon = await new Daemon({
    dataDir: tempDir(),
    flavor: "dev",
    link: server.link(),
    credential: "cred-1",
    harnesses: [{ harness: "mock", installed: true, version: "test" }],
    mockSpeed: 2,
    heartbeatMs: 50,
    commandsWaitSeconds: 1,
  }).start()
  daemons.push(daemon)
  await daemon.syncWithServer()
  return { server, daemon }
}

function queueLongRun(server: MemoryServer) {
  return server.queueRun(DEVICE, {
    issueId: "issue-long",
    repoId: "repo-1",
    baseBranch: "main",
    harness: "mock",
    prompt: "do it",
    fixture: "long-running",
  })
}

function text(chunks: RunChunk[]) {
  return chunks
    .flatMap((c) => (c.type === "text-delta" ? [c.delta] : []))
    .join("")
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  cleanupTempDirs()
})

describe("run commands", () => {
  it("hands a person's message to the running agent and acks it once", async () => {
    const { server, daemon } = await setup()
    const runId = queueLongRun(server)
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")

    const messageId = server.sendInput(runId, "use pnpm")
    await waitFor(() => server.inputs.get(messageId)?.deliveredAt)
    await waitFor(() =>
      text(server.chunksFor(runId)).includes("Noted: use pnpm")
    )

    // Acked: the next long-poll no longer hands it out.
    const pending = await server.link().fetchCommands(DEVICE, 0)
    expect(pending).toEqual([])
  })

  it("cancels the run when a person stops it, and closes its message", async () => {
    const { server, daemon } = await setup()
    const runId = queueLongRun(server)
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")
    await waitFor(() => text(server.chunksFor(runId)).includes("step 1."))

    server.requestStop(runId)
    await daemon.supervisor.idle()
    await waitFor(() => daemon.status().pendingUploads === 0)
    expect(daemon.supervisor.get(runId)).toMatchObject({
      state: "cancelled",
      stopReason: "cancelled",
    })
    expect(server.runs.get(runId)?.completion?.stopReason).toBe("cancelled")

    // Every message that started also finished; run state is never stored.
    const chunks = server.chunksFor(runId)
    const stored = chunks.filter(
      (c) => !(c.type === "data-run-state" && c.transient)
    )
    expect(chunks.filter((c) => c.type === "data-run-state").length).toBe(
      chunks.length - stored.length
    )
    expect(stored.filter((c) => c.type === "start").length).toBe(
      stored.filter((c) => c.type === "finish").length
    )
    expect(stored.at(-1)?.type).toBe("finish")
  })

  it("keeps taking messages for other runs while one is being stopped", async () => {
    const { server, daemon } = await setup()
    const stopped = queueLongRun(server)
    const other = server.queueRun(DEVICE, {
      issueId: "issue-other",
      repoId: "repo-1",
      baseBranch: "main",
      harness: "mock",
      prompt: "do it",
      fixture: "long-running",
    })
    await daemon.syncWithServer()
    await waitFor(
      () =>
        daemon.supervisor.get(stopped).state === "running" &&
        daemon.supervisor.get(other).state === "running"
    )

    server.requestStop(stopped)
    await waitFor(() => daemon.supervisor.get(stopped).state === "cancelled")
    const sentAt = Date.now()
    const messageId = server.sendInput(other, "use pnpm")
    await waitFor(() => server.inputs.get(messageId)?.deliveredAt)
    // The stop still pending on the server must not hold up the poll.
    expect(server.inputs.get(messageId)!.deliveredAt! - sentAt).toBeLessThan(
      500
    )
  })

  it("runs overlapping server passes one after another, so it registers once", async () => {
    const server = new MemoryServer()
    const link = server.link()
    let registrations = 0
    const daemon = await new Daemon({
      dataDir: tempDir(),
      flavor: "dev",
      link: {
        ...link,
        registerDevice: (...args) => {
          registrations++
          return link.registerDevice(...args)
        },
      },
      credential: "cred-1",
      harnesses: [{ harness: "mock", installed: true, version: "test" }],
      heartbeatMs: 60_000,
      commandsWaitSeconds: 1,
    }).start()
    daemons.push(daemon)
    await Promise.all([daemon.syncWithServer(), daemon.syncWithServer()])
    expect(registrations).toBe(1)
  })

  it("ignores commands for runs it does not have, and keeps polling after a network cut", async () => {
    const { server, daemon } = await setup()
    server.online = false
    await new Promise((resolve) => setTimeout(resolve, 300))
    server.online = true
    const runId = queueLongRun(server)
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.get(runId).state === "running")
    server.sendInput("someone-elses-run", "hello")
    const messageId = server.sendInput(runId, "still there?")
    await waitFor(() => server.inputs.get(messageId)?.deliveredAt, 20_000)
  })
})
