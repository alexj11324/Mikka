import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { DaemonError } from "./errors"
import { createLogger } from "./log"
import { Outbox, type OutboxItem } from "./outbox"
import { MemoryServer, type ServerLink } from "./server-link"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "orvo-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const log = createLogger()

function chunk(seq: number): OutboxItem {
  return {
    kind: "chunk",
    seq,
    chunk: { type: "text-delta", id: "t", delta: `step ${seq}` },
  }
}

const COMPLETE: OutboxItem = {
  kind: "complete",
  completion: {
    stopReason: "cancelled",
    report: {
      summary: "",
      filesChanged: [],
      verify: { status: "not_run" },
      openQuestions: [],
      nextStep: null,
    },
  },
}

describe("outbox torn lines", () => {
  it("keeps the good prefix, truncates the torn tail before appending", async () => {
    const dir = tempDir()
    const server = new MemoryServer("d")
    server.online = false
    const file = join(dir, "run-1.jsonl")
    writeFileSync(file, `${JSON.stringify(chunk(1))}\n{"kind":"chu`)
    const outbox = new Outbox(dir, server.link(), log, 10_000)
    // The torn line does not hide what is before it.
    expect(outbox.pending()).toBe(1)

    outbox.push("run-1", chunk(2))
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2])

    server.online = true
    await outbox.flush("run-1")
    expect(server.chunksFor("run-1").map((c) => c.type)).toEqual([
      "text-delta",
      "text-delta",
    ])
    await outbox.close()
  })

  it("never compacts an outbox that did not parse", async () => {
    const dir = tempDir()
    const server = new MemoryServer("d")
    const file = join(dir, "run-1.jsonl")
    // Corruption before the tail: delivery stops before it, nothing is deleted.
    writeFileSync(
      file,
      `${JSON.stringify(chunk(1))}\nnot json\n${JSON.stringify(COMPLETE)}\n`
    )
    const outbox = new Outbox(dir, server.link(), log, 10_000)
    await outbox.compact("run-1")
    expect(existsSync(file)).toBe(true)
    expect(server.chunksFor("run-1")).toHaveLength(1)
    await outbox.close()
  })
})

describe("outbox delivery", () => {
  it("drops refused chunk batches, surfaces a refused completion, and finishes", async () => {
    const dir = tempDir()
    const refused: string[] = []
    const calls: string[] = []
    const link: ServerLink = {
      ...new MemoryServer("d").link(),
      appendRunChunks: async () => {
        calls.push("chunks")
        throw new DaemonError(400, "bad batch")
      },
      completeRun: async () => {
        calls.push("complete")
        throw new DaemonError(409, "conflict")
      },
    }
    const outbox = new Outbox(dir, link, log, 10, (runId, item) => {
      refused.push(`${runId}:${item.kind}`)
    })
    outbox.push("run-1", chunk(1))
    outbox.push("run-1", COMPLETE)
    await outbox.flush("run-1")
    // Wait past a retry interval: refused items are never resent.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await outbox.flushAll()
    expect(calls.filter((c) => c === "complete")).toHaveLength(1)
    expect(refused).toEqual(["run-1:complete"])
    expect(outbox.pending()).toBe(0)
    expect(existsSync(join(dir, "run-1.jsonl"))).toBe(false)
    await outbox.close()
  })

  it("removes a finished run's outbox once it is delivered after a cut", async () => {
    const dir = tempDir()
    const server = new MemoryServer("d")
    server.online = false
    const outbox = new Outbox(dir, server.link(), log, 10)
    outbox.push("run-1", chunk(1))
    outbox.push("run-1", COMPLETE)
    await outbox.compact("run-1")
    expect(existsSync(join(dir, "run-1.jsonl"))).toBe(true)
    server.online = true
    await outbox.flushAll()
    expect(existsSync(join(dir, "run-1.jsonl"))).toBe(false)
    expect(server.chunksFor("run-1")).toHaveLength(1)
    await outbox.close()
  })

  it("reports the highest chunk seq for resume reconciliation", () => {
    const dir = tempDir()
    const outbox = new Outbox(dir, new MemoryServer("d").link(), log)
    appendFileSync(join(dir, "run-1.jsonl"), "")
    outbox.push("run-1", chunk(4))
    expect(outbox.lastChunkSeq("run-1")).toBe(4)
    expect(outbox.lastChunkSeq("run-2")).toBe(0)
  })
})
