// Disk-backed, ordered outbox per run (R13). Every chunk and run update is
// appended to `outbox/<runId>.jsonl` before it is sent; `<runId>.ack.json`
// records how many lines the server accepted and the run stream's last
// acknowledged offset. A network cut only delays delivery: the run keeps
// going, and on reconnect (or daemon restart) the outbox replays from the
// last acknowledged position, in order.
//
// A crash mid-append can leave a torn last line. Reading stops at the first
// line that does not parse; a torn tail is truncated before the next append,
// and an outbox that did not parse cleanly is never compacted.
//
// An item the server refuses (4xx) is never retried: a chunk batch is
// dropped with a logged error, a refused completion is handed to
// `onUndeliverable` so the daemon can show it, and delivery moves on. Once the
// completion is delivered (or refused) the run's outbox is removed.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
} from "node:fs"
import { join } from "node:path"

import type { RunCompletion } from "@mikka/protocol"

import type { RunChunk } from "./chunks"
import { isNonRetryable, ServerUnreachableError } from "./errors"
import { readJson, writeJsonAtomic } from "./fs-util"
import { assertSafeId, isSafeId } from "./ids"
import type { Logger } from "./log"
import type { RunPatch, ServerLink } from "./server-link"

export type OutboxItem =
  | { kind: "chunk"; seq: number; chunk: RunChunk }
  | { kind: "run"; patch: RunPatch }
  | { kind: "complete"; completion: RunCompletion }

interface Ack {
  /** Lines of the outbox file accepted (or refused for good) by the server. */
  lines: number
  /** Tail offset of the run's durable stream after the last append. */
  offset: string | null
}

interface Parsed {
  items: OutboxItem[]
  /** Bytes of the file covered by `items` (complete, parsed lines). */
  validBytes: number
  /** Some bytes after `validBytes` did not parse. */
  torn: boolean
  /** The unparsable bytes are the file's last line (a torn append). */
  tornTail: boolean
}

export class Outbox {
  private chains = new Map<string, Promise<void>>()
  private retryTimer: NodeJS.Timeout | null = null
  private closed = false
  /** Runs whose file was checked for a torn tail since this process started. */
  private repaired = new Set<string>()

  constructor(
    private readonly dir: string,
    private readonly link: ServerLink,
    private readonly log: Logger,
    private readonly retryMs = 1_000,
    /** A completion the server refused for good (4xx). */
    private readonly onUndeliverable: (
      runId: string,
      item: OutboxItem,
      error: unknown
    ) => void = () => undefined,
    private readonly retainResources = false
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  private file(runId: string) {
    return join(this.dir, `${assertSafeId("run id", runId)}.jsonl`)
  }
  private ackFile(runId: string) {
    return join(this.dir, `${assertSafeId("run id", runId)}.ack.json`)
  }

  private parse(runId: string): Parsed {
    let data: Buffer
    try {
      data = readFileSync(this.file(runId))
    } catch {
      return { items: [], validBytes: 0, torn: false, tornTail: false }
    }
    const items: OutboxItem[] = []
    let start = 0
    while (start < data.length) {
      const end = data.indexOf(0x0a, start)
      // No newline: the last append was cut short.
      if (end === -1) {
        return { items, validBytes: start, torn: true, tornTail: true }
      }
      const line = data.subarray(start, end).toString("utf8")
      if (line.trim()) {
        try {
          items.push(JSON.parse(line) as OutboxItem)
        } catch {
          const rest = data.subarray(end + 1).toString("utf8")
          return {
            items,
            validBytes: start,
            torn: true,
            tornTail: rest.trim() === "",
          }
        }
      }
      start = end + 1
    }
    return { items, validBytes: start, torn: false, tornTail: false }
  }

  private items(runId: string): OutboxItem[] {
    return this.parse(runId).items
  }

  /**
   * Cuts a torn last line (crash mid-append) so the next append starts on a
   * line of its own. Corruption before the tail is left for a human: it is
   * logged and the outbox is never compacted.
   */
  private repair(runId: string) {
    if (this.repaired.has(runId)) return
    const parsed = this.parse(runId)
    if (parsed.torn && parsed.tornTail) {
      this.log.warn(
        { run_id: runId, valid_bytes: parsed.validBytes },
        "outbox had a torn last line; truncating it"
      )
      truncateSync(this.file(runId), parsed.validBytes)
    } else if (parsed.torn) {
      this.log.error(
        { run_id: runId, valid_bytes: parsed.validBytes },
        "outbox has an unreadable line; delivery stops before it"
      )
    }
    this.repaired.add(runId)
  }

  /** Highest chunk seq in the run's outbox (0 when none). */
  lastChunkSeq(runId: string): number {
    return this.items(runId).reduce(
      (max, item) => (item.kind === "chunk" ? Math.max(max, item.seq) : max),
      0
    )
  }

  ack(runId: string): Ack {
    return (
      (readJson(this.ackFile(runId)) as Ack | undefined) ?? {
        lines: 0,
        offset: null,
      }
    )
  }

  /** Persist first, then try to deliver. Never throws on network errors. */
  push(runId: string, item: OutboxItem) {
    this.repair(runId)
    appendFileSync(this.file(runId), `${JSON.stringify(item)}\n`, {
      mode: 0o600,
    })
    void this.flush(runId)
  }

  /** Items not yet accepted by the server, across all runs. */
  pending(): number {
    return this.runIds().reduce(
      (sum, runId) =>
        sum + Math.max(0, this.items(runId).length - this.ack(runId).lines),
      0
    )
  }

  runIds(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -".jsonl".length))
        .filter((runId) => isSafeId(runId))
    } catch {
      return []
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all(this.runIds().map((id) => this.flush(id)))
  }

  /** Serialized per run so items always leave in append order. */
  flush(runId: string): Promise<void> {
    const previous = this.chains.get(runId) ?? Promise.resolve()
    const next = previous.then(() => this.deliver(runId))
    this.chains.set(runId, next)
    return next
  }

  private async deliver(runId: string) {
    if (this.closed) return
    this.repair(runId)
    const parsed = this.parse(runId)
    const { items } = parsed
    const ack = this.ack(runId)
    try {
      while (ack.lines < items.length) {
        if (this.closed) return
        const item = items[ack.lines]
        let end = ack.lines + 1
        try {
          if (item.kind === "chunk") {
            end = ack.lines
            while (end < items.length && items[end].kind === "chunk") end++
            const batch = items.slice(ack.lines, end) as Extract<
              OutboxItem,
              { kind: "chunk" }
            >[]
            const { offset } = await this.link.appendRunChunks(runId, {
              fromSeq: batch[0].seq,
              chunks: batch.map((i) => i.chunk),
            })
            ack.offset = offset
          } else if (item.kind === "run") {
            await this.link.updateRun(runId, item.patch)
          } else {
            await this.link.completeRun(runId, item.completion)
          }
        } catch (error) {
          if (!isNonRetryable(error)) throw error
          // The server refused it; resending the same request cannot help.
          this.log.error(
            {
              run_id: runId,
              kind: item.kind,
              items: end - ack.lines,
              err: error,
            },
            "server refused outbox items; dropping them"
          )
          if (item.kind === "complete") this.onUndeliverable(runId, item, error)
        }
        ack.lines = end
        writeJsonAtomic(this.ackFile(runId), ack)
      }
    } catch (error) {
      if (!(error instanceof ServerUnreachableError)) {
        this.log.error({ run_id: runId, err: error }, "outbox delivery failed")
      }
      this.scheduleRetry()
      return
    }
    // The completion is the run's last item: once it is through, the run's
    // outbox is done, even if it was delivered after a network cut.
    if (!parsed.torn && items.at(-1)?.kind === "complete") this.remove(runId)
  }

  private remove(runId: string) {
    if (this.retainResources) return
    rmSync(this.file(runId), { force: true })
    rmSync(this.ackFile(runId), { force: true })
  }

  private scheduleRetry() {
    if (this.retryTimer || this.closed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flushAll()
    }, this.retryMs)
    this.retryTimer.unref()
  }

  /** Drop a run's outbox once everything is delivered and the run is over. */
  async compact(runId: string) {
    await this.flush(runId)
    const parsed = this.parse(runId)
    if (parsed.torn) return
    if (this.ack(runId).lines >= parsed.items.length) this.remove(runId)
  }

  async close() {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    await Promise.all(this.chains.values())
  }
}
