// Process plumbing shared by the real adapters: one sandboxed CLI child per
// session, and the single-consumer event queue a session's `events()` reads.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

import { execa } from "execa"

import type { AgentEvent, AgentSession, ExitEvent } from "../adapters/types"
import type { RunChunk } from "../chunks"
import { ownDir } from "./harness-home"
import type { AgentSandbox, SandboxPolicy } from "./sandbox"

/** Push-based queue behind `AgentSession.events()`; ends after `exit`. */
export class EventQueue {
  private items: AgentEvent[] = []
  private waiter: (() => void) | null = null
  private ended = false

  chunk(chunk: RunChunk) {
    this.push({ type: "chunk", chunk })
  }

  /** Only the first exit counts; later ones are dropped. */
  exit(event: Omit<ExitEvent, "type">) {
    if (this.ended) return
    this.push({ type: "exit", ...event })
    this.ended = true
  }

  get done() {
    return this.ended
  }

  private push(event: AgentEvent) {
    if (this.ended) return
    this.items.push(event)
    this.waiter?.()
    this.waiter = null
  }

  async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.items.shift()
      if (next) {
        yield next
        if (next.type === "exit") return
        continue
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/** A session that ends at once with `exit` (a hand-in found on resume). */
export function endedSession(sessionId: string, exit: ExitEvent): AgentSession {
  return {
    sessionId,
    replayedHandoff: true,
    async *events() {
      yield exit
    },
    async send() {
      throw new Error("The session already ended")
    },
    async cancel() {},
  }
}

export interface CliChild {
  readonly process: ChildProcessWithoutNullStreams
  /** Resolves with the exit code (or signal) once the process is gone. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  /** Last part of stderr plus any sandbox violations, for error messages. */
  stderrTail(): string
  /** SIGTERM to the whole process group, SIGKILL after `graceMs`; resolves once the CLI is gone. */
  kill(graceMs?: number): Promise<void>
}

const STDERR_TAIL = 4000

function signalGroup(pgid: number | undefined, signal: NodeJS.Signals) {
  if (pgid === undefined) return
  try {
    // The whole group: shells, MCP servers and jobs the CLI left behind,
    // even after the CLI itself (the group leader) has exited.
    process.kill(-pgid, signal)
  } catch {
    // Nobody left in the group.
  }
}

/**
 * Kills what an earlier daemon left running for this run (a crash skips
 * `kill`). The group is only signalled while its leader still carries
 * `marker` (the run dir, part of its sandbox profile), so a reused pid is
 * never touched.
 */
async function reapStale(pidFile: string, marker: string) {
  let pgid: number
  try {
    pgid = Number.parseInt(readFileSync(pidFile, "utf8"), 10)
  } catch {
    return
  }
  if (!Number.isInteger(pgid) || pgid <= 1) return
  // The leader often died first; its group lives on while any member does
  // (and its id is not reused until then). Members carry the run dir too.
  const ps = await execa("ps", ["-A", "-o", "pgid=,command="], {
    reject: false,
  })
  const member = ps.stdout.split("\n").some((line) => {
    const [group, ...command] = line.trim().split(/\s+/)
    return Number(group) === pgid && command.join(" ").includes(marker)
  })
  if (member) signalGroup(pgid, "SIGKILL")
}

/**
 * Takes the run's dir for a new session: kills whatever an earlier daemon
 * left running there, then makes sure the dir is a real directory (its
 * parent is daemon-only, so the returned real path stays trustworthy).
 * Call before writing anything into it.
 */
export async function claimRunDir(paths: {
  runDir: string
  pidFile: string
}): Promise<string> {
  ownDir(paths.runDir)
  const runDir = realpathSync(paths.runDir)
  await reapStale(paths.pidFile, runDir)
  return runDir
}

/**
 * Starts `argv` inside the sandbox, in its own process group so `kill`
 * reaches the CLI and everything it started (shells, MCP servers). The
 * group id is kept in `pidFile` until the group is gone.
 */
export async function spawnCli(
  sandbox: AgentSandbox,
  argv: string[],
  options: {
    cwd: string
    env: Record<string, string>
    policy: SandboxPolicy
    /** Daemon-only file for the group id (outside the sandbox's reach). */
    pidFile: string
    /** Text only this run's CLI command carries (its run dir). */
    marker: string
  }
): Promise<CliChild> {
  await reapStale(options.pidFile, options.marker)
  const wrapped = await sandbox.wrap(argv, options.policy)
  const child = spawn("/bin/sh", ["-c", wrapped.command], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  })
  const pgid = child.pid
  if (pgid !== undefined) {
    mkdirSync(dirname(options.pidFile), { recursive: true, mode: 0o700 })
    rmSync(options.pidFile, { force: true })
    writeFileSync(options.pidFile, String(pgid), { flag: "wx", mode: 0o600 })
  }
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (data: string) => {
    stderr = (stderr + data).slice(-STDERR_TAIL * 4)
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("error", (error) => {
        stderr += `\n${error.message}`
        resolve({ code: null, signal: null })
      })
      child.once("exit", (code, signal) => resolve({ code, signal }))
    }
  ).finally(() => {
    // Nothing of a session outlives its CLI.
    signalGroup(pgid, "SIGKILL")
    rmSync(options.pidFile, { force: true })
    wrapped.release()
  })
  // A closed stdin (the CLI exited) must not crash the daemon.
  child.stdin.on("error", () => undefined)

  return {
    process: child,
    exited,
    stderrTail: () => wrapped.annotate(stderr.slice(-STDERR_TAIL)).trim(),
    async kill(graceMs = 3000) {
      signalGroup(pgid, "SIGTERM")
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, graceMs)
        }),
      ])
      clearTimeout(timer)
      signalGroup(pgid, "SIGKILL")
      await exited
    },
  }
}

/**
 * Rejects when the CLI exits or `ms` passes before `step` settles, so a
 * CLI that dies or wedges during its handshake never leaves `start` hanging.
 */
export async function untilReady<T>(
  child: CliChild,
  step: Promise<T>,
  label: string,
  ms = 120_000
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      step,
      child.exited.then(({ code, signal }) => {
        throw new Error(`${label}: the CLI exited (${signal ?? code})`)
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: no answer after ${ms / 1000} s`)),
          ms
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Splits a stream into lines (newline-delimited JSON protocols). */
export function onLines(
  stream: NodeJS.ReadableStream,
  handle: (line: string) => void
) {
  let buffer = ""
  stream.setEncoding("utf8")
  stream.on("data", (data: string) => {
    buffer += data
    for (let index; (index = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) handle(line)
    }
  })
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
