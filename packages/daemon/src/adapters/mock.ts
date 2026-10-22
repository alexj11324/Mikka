// Mock harness: replays recorded-session fixtures (`fixtures/*.jsonl`) with
// their original timing scaled by `speed`. One JSON object per line:
//
//   { "t": <ms offset>, "chunk": <UIMessageChunk> }
//   { "t": <ms offset>, "chunk": ..., "write": { "path": "...", "content": "..." } }
//   { "t": <ms offset>, "exec": { "toolCallId": "...", "command": "bun test" } }
//   { "t": <ms offset>, "submit": { "summary": "...", "nextStep": "..." } }
//   { "t": <ms offset>, "hang": true }
//   { "t": <ms offset>, "exit": { "outcome": "failed", "stopReason": "blocked", "error": "...", "report": { ... } } }
//
// `submit` stands for the agent's explicit hand-in (`mikka_submit` in real
// harnesses) and carries its part of the handoff report. A session that
// exits "succeeded" without one ends as `turn_ended`, not as success.
// `hang` stops making progress until the session is cancelled (watchdog
// and lease tests).
//
// `write` is applied to the worktree before its chunk is emitted. `exec`
// runs a project command in the worktree with the run's clean env and emits
// it as a tool call + tool output, like a real harness running tests. Session
// progress lives in the adapter's state dir, like a real CLI's local session
// store, so `resume(sessionId)` continues after a daemon restart. The
// store also keeps every first message the session got (the brief, then
// each follow-up a later run continued it with), so tests can tell a
// continued conversation from a new one; the fixture replays either way.
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { execa } from "execa"

import { isRunChunk, type RunChunk } from "../chunks"
import { readJson, writeJsonAtomic } from "../fs-util"
import { assertSafeId, isSafeId } from "../ids"
import { classifyWrite } from "../permissions"
import type {
  AgentAdapter,
  AgentEvent,
  AgentReport,
  AgentSession,
  ExitEvent,
  SessionOptions,
  StartOptions,
} from "./types"

export const DEFAULT_FIXTURES_DIR = resolve(
  import.meta.dirname,
  "../../fixtures"
)

export interface FixtureLine {
  t: number
  chunk?: RunChunk
  write?: { path: string; content: string }
  exec?: { toolCallId: string; command: string }
  submit?: AgentReport
  hang?: boolean
  exit?: Omit<ExitEvent, "type">
}

export function parseFixture(text: string, name = "fixture"): FixtureLine[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as FixtureLine
      const where = `${name}:${index + 1}`
      if (typeof value.t !== "number") throw new Error(`${where}: missing "t"`)
      if (value.chunk !== undefined && !isRunChunk(value.chunk)) {
        throw new Error(`${where}: "chunk" is not a UI message chunk`)
      }
      if (
        !value.chunk &&
        !value.exit &&
        !value.exec &&
        !value.submit &&
        !value.hang
      ) {
        throw new Error(
          `${where}: needs "chunk", "exec", "submit", "hang" or "exit"`
        )
      }
      return value
    })
}

interface MockSessionState {
  fixture: string
  /** Index of the next fixture line to replay. */
  next: number
  /** The brief, then each follow-up message, in order. */
  messages?: string[]
}

export interface MockAdapterOptions {
  /** Where session progress is stored (the daemon's adapter state dir). */
  stateDir: string
  fixturesDir?: string
  /** Playback speed: 1 = recorded timing, 10 = ten times faster, Infinity = instant. */
  speed?: number
}

export class MockAdapter implements AgentAdapter {
  readonly harness = "mock" as const
  readonly capabilities = { supportsInterject: true, supportsResume: true }
  readonly envAllow: readonly string[] = []
  private readonly fixturesDir: string
  private readonly speed: number

  constructor(private readonly options: MockAdapterOptions) {
    this.fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR
    this.speed = options.speed ?? 1
    mkdirSync(options.stateDir, { recursive: true })
  }

  private stateFile(sessionId: string) {
    return join(
      this.options.stateDir,
      `mock-${assertSafeId("session id", sessionId)}.json`
    )
  }

  async start(options: StartOptions): Promise<AgentSession> {
    const fixture = options.fixture ?? "success-edit"
    const continued = options.continueSession
    if (continued) {
      const earlier = isSafeId(continued.sessionId)
        ? this.readState(continued.sessionId)
        : undefined
      if (earlier) {
        // The same conversation, one message longer; the run's own fixture.
        const state: MockSessionState = {
          fixture,
          next: 0,
          messages: [...(earlier.messages ?? []), continued.message],
        }
        writeJsonAtomic(this.stateFile(continued.sessionId), state)
        return this.open(continued.sessionId, state, options)
      }
      options.log.info(
        { session_id: continued.sessionId },
        "mock session not found; starting a new one"
      )
    }
    const sessionId = `mock-${randomUUID()}`
    const state: MockSessionState = {
      fixture,
      next: 0,
      messages: [options.prompt],
    }
    writeJsonAtomic(this.stateFile(sessionId), state)
    return this.open(sessionId, state, options)
  }

  private readState(sessionId: string): MockSessionState | undefined {
    return readJson(this.stateFile(sessionId)) as MockSessionState | undefined
  }

  async resume(
    sessionId: string,
    options: SessionOptions
  ): Promise<AgentSession> {
    const state = this.readState(sessionId)
    if (!state) throw new Error(`mock: unknown session ${sessionId}`)
    return this.open(sessionId, state, options)
  }

  private open(
    sessionId: string,
    state: MockSessionState,
    options: SessionOptions
  ): AgentSession {
    // The fixture name comes from the server: no paths, just a name.
    const name = assertSafeId("fixture", state.fixture.replace(/\.jsonl$/, ""))
    const lines = parseFixture(
      readFileSync(join(this.fixturesDir, `${name}.jsonl`), "utf8"),
      name
    )
    const abort = new AbortController()
    const inbox: string[] = []
    const saveState = (next: number) =>
      writeJsonAtomic(this.stateFile(sessionId), { ...state, next })
    const speed = this.speed
    // Stateless across resume: a submission is any `submit` line replayed so far.
    const exitEvent = (
      exit: Omit<ExitEvent, "type">,
      upTo: number
    ): ExitEvent => {
      const submit = lines
        .slice(0, upTo)
        .findLast((line) => line.submit)?.submit
      return exit.outcome === "succeeded" && submit
        ? { type: "exit", stopReason: "submitted", report: submit, ...exit }
        : { type: "exit", ...exit }
    }

    async function* events(): AsyncGenerator<AgentEvent> {
      let previousT = state.next > 0 ? lines[state.next - 1].t : 0
      for (let index = state.next; index < lines.length; index++) {
        const line = lines[index]
        const delay =
          Number.isFinite(speed) && speed > 0 ? (line.t - previousT) / speed : 0
        previousT = line.t
        try {
          if (delay > 0) await sleep(delay, undefined, { signal: abort.signal })
        } catch {
          // Aborted by cancel.
        }
        if (abort.signal.aborted) {
          yield { type: "exit", outcome: "cancelled" }
          return
        }
        while (inbox.length > 0) {
          const text = inbox.shift() as string
          const id = `ack-${randomUUID()}`
          yield { type: "chunk", chunk: { type: "text-start", id } }
          yield {
            type: "chunk",
            chunk: { type: "text-delta", id, delta: `Noted: ${text}` },
          }
          yield { type: "chunk", chunk: { type: "text-end", id } }
        }
        if (line.hang) {
          if (!abort.signal.aborted) {
            await new Promise((resolve) =>
              abort.signal.addEventListener("abort", resolve, { once: true })
            )
          }
          yield { type: "exit", outcome: "cancelled" }
          return
        }
        if (line.write) {
          if (
            classifyWrite(options.cwd, line.write.path) !== "write_in_worktree"
          ) {
            throw new Error(
              `mock fixture writes outside the worktree: ${line.write.path}`
            )
          }
          const target = resolve(options.cwd, line.write.path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, line.write.content)
        }
        // Progress is saved after the consumer took the event, so a crash
        // replays at most the last event (at-least-once).
        if (line.chunk) yield { type: "chunk", chunk: line.chunk }
        if (line.exec) {
          const { toolCallId, command } = line.exec
          yield {
            type: "chunk",
            chunk: {
              type: "tool-input-available",
              toolCallId,
              toolName: "bash",
              input: { command },
            },
          }
          const result = await execa(command, {
            shell: true,
            cwd: options.cwd,
            env: options.env,
            extendEnv: false,
            reject: false,
            all: true,
            stdin: "ignore",
            cancelSignal: abort.signal,
          })
          yield {
            type: "chunk",
            chunk: {
              type: "tool-output-available",
              toolCallId,
              output: {
                exitCode: result.exitCode ?? null,
                output: String(result.all ?? "").slice(-4000),
              },
            },
          }
        }
        saveState(index + 1)
        if (line.exit) {
          yield exitEvent(line.exit, index + 1)
          return
        }
      }
      // Resumed after the last line was consumed: repeat its outcome.
      yield exitEvent(
        lines.at(-1)?.exit ?? { outcome: "succeeded" },
        lines.length
      )
    }

    return {
      sessionId,
      events,
      async send(text) {
        inbox.push(text)
      },
      async cancel() {
        abort.abort()
      },
    }
  }
}
