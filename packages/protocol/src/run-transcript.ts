// Merges a run's stored messages (Zero rows) with the relay's live stream into
// one ordered transcript of AI SDK `UIMessage`s (ADR 0018). Framework-free:
// desktop `lib/run-chat.ts` and the phone's `src/backend/RunChat.ts` drive it
// from their own React hooks.
//
//   - Zero (`queries.runs.messages`): the stored messages, in `seq` order.
//     An assistant message gets its row when it starts (no parts yet) and its
//     parts when it finishes; a member's message shows `deliveredAt` once the
//     agent has it.
//   - the relay: the message the agent is writing right now, assembled from
//     its UIMessageChunks with the AI SDK's `readUIMessageStream`, and
//     `message.final` events that replace it.
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai"

import type { RunState } from "./daemon"
import type { RunEvent } from "./relay"

export interface ChatMessage extends UIMessage {
  /** The agent is still writing it. */
  streaming?: boolean
  /** A member's message the server has not saved yet. */
  sending?: boolean
  /** A member's message the agent has received. */
  delivered?: boolean
  /** Sending it failed: the relay's error code, or `generic`. */
  failed?: string
}

/** A `message` row as Zero syncs it. */
export interface MessageRow {
  id: string
  role: string
  seq: number
  parts: unknown
  deliveredAt?: number | null
}

interface Live {
  message: UIMessage | undefined
  push(chunk: UIMessageChunk): void
  end(): void
}

function liveMessage(onUpdate: () => void): Live {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c
    },
  })
  let ended = false
  const live: Live = {
    message: undefined,
    push(chunk) {
      if (!ended) controller.enqueue(chunk)
    },
    end() {
      if (ended) return
      ended = true
      controller.close()
    },
  }
  void (async () => {
    for await (const message of readUIMessageStream({
      stream,
      // A chunk that does not apply (a part cut by a reconnect) is skipped.
      onError: () => undefined,
    })) {
      live.message = message
      onUpdate()
    }
  })()
  return live
}

/**
 * Merges stored rows and relay events into one ordered transcript.
 * Framework-free; `useRunChat` drives it.
 */
export class RunTranscript {
  private rows: MessageRow[] = []
  /** Finished messages from the relay, by id, with their seq. */
  private readonly finals = new Map<
    string,
    { seq: number; message: UIMessage }
  >()
  /** Messages the agent is writing, in the order they started. */
  private readonly live = new Map<string, Live>()
  /** A member's messages not yet saved (or that failed), by id. */
  private readonly outgoing = new Map<string, ChatMessage>()
  private state: RunState | null = null
  private cached: ChatMessage[] | null = null

  constructor(private readonly onChange: () => void) {}

  private changed = () => {
    this.cached = null
    this.onChange()
  }

  setRows(rows: readonly MessageRow[]) {
    this.rows = [...rows]
    for (const row of rows) {
      const out = this.outgoing.get(row.id)
      if (out && !out.failed) this.outgoing.delete(row.id)
    }
    this.changed()
  }

  apply(event: RunEvent) {
    if (event.kind === "run.status") return
    if (event.kind === "message.final") {
      this.finals.set(event.message.id, {
        seq: event.seq,
        message: event.message,
      })
      this.live.get(event.message.id)?.end()
      this.live.delete(event.message.id)
      this.outgoing.delete(event.message.id)
      return this.changed()
    }
    const { chunk, messageId } = event
    if (chunk.type === "data-run-state") {
      this.state = (chunk.data as { state: RunState }).state
      return this.changed()
    }
    if (this.finals.has(messageId)) return
    let live = this.live.get(messageId)
    if (!live) {
      live = liveMessage(this.changed)
      this.live.set(messageId, live)
    }
    live.push(chunk)
    if (chunk.type === "finish" || chunk.type === "abort") live.end()
  }

  /** A member's message, shown before the server confirms it. */
  addOutgoing(id: string, text: string) {
    this.outgoing.set(id, {
      id,
      role: "user",
      parts: [{ type: "text", text }],
      sending: true,
    })
    this.changed()
  }

  failOutgoing(id: string, reason: string) {
    const out = this.outgoing.get(id)
    if (!out) return
    this.outgoing.set(id, { ...out, sending: false, failed: reason })
    this.changed()
  }

  /** Last run state the daemon streamed (live), if any. */
  runState(): RunState | null {
    return this.state
  }

  messages(): ChatMessage[] {
    if (this.cached) return this.cached
    const bySeq = new Map<string, { seq: number; message: ChatMessage }>()
    for (const row of this.rows) {
      bySeq.set(row.id, {
        seq: row.seq,
        message: {
          id: row.id,
          role: row.role as UIMessage["role"],
          parts: (row.parts ?? []) as UIMessage["parts"],
          ...(row.role === "user" ? { delivered: !!row.deliveredAt } : {}),
        },
      })
    }
    for (const [id, final] of this.finals) {
      const known = bySeq.get(id)
      bySeq.set(id, {
        seq: final.seq,
        message: { ...known?.message, ...final.message },
      })
    }
    const ordered = [...bySeq.values()]
      .sort((a, b) => a.seq - b.seq)
      .map(({ message }) => {
        const live = this.live.get(message.id)
        // A started row has no parts until it finishes: show the live text.
        return live?.message && message.parts.length === 0
          ? { ...message, parts: live.message.parts, streaming: true }
          : message
      })
      // A row a server restart left without parts has nothing to show.
      .filter((m) => m.role !== "assistant" || m.parts.length > 0)
    const shown = new Set(ordered.map((m) => m.id))
    for (const [id, live] of this.live) {
      if (shown.has(id) || !live.message) continue
      ordered.push({ ...live.message, id, role: "assistant", streaming: true })
    }
    for (const out of this.outgoing.values())
      if (!shown.has(out.id)) ordered.push(out)
    this.cached = ordered
    return ordered
  }
}
