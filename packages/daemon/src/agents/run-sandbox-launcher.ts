// One trusted Node launcher per run. The CLI gets streams, never the launcher's
// IPC descriptor; the callback closure, not proxy-supplied attribution, owns a run.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { isIP } from "node:net"
import { isAbsolute } from "node:path"
import type { Writable } from "node:stream"
import { fileURLToPath } from "node:url"

import { NetworkConfigSchema } from "@anthropic-ai/sandbox-runtime"

import type { CliChild } from "./child"
import type { SandboxPolicy } from "./sandbox"

const MAX_PENDING_NETWORK = 128
const NETWORK_DECISION_MS = 5 * 60_000

export interface RunSandboxNetworkRequest {
  host: string
  port: number
}

export interface RunSandboxLaunchOptions {
  command: string
  args: readonly string[]
  cwd: string
  /** The CLI receives exactly this environment, never the daemon's env. */
  env: Readonly<Record<string, string | undefined>>
  policy: SandboxPolicy
  /** Immutable ceiling, including any model API hosts. Empty means no network. */
  maxAllowDomains: readonly string[]
  /** Metadata for the caller's live-check path; this never extends the ceiling. */
  modelApiDomains?: readonly string[]
  /** Invoked for EVERY in-cap connection, including model APIs. Failures deny. */
  onNetwork(request: RunSandboxNetworkRequest, signal: AbortSignal): Promise<boolean>
  signal?: AbortSignal
  /** Native Claude token, delivered only through fd 3, never argv/env/IPC. */
  authToken?: string
}

export interface RunSandboxChild extends CliChild {
  /** Deny pending/new network and stop this run, including established sockets. */
  revoke(): Promise<void>
}

function canonicalHost(host: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in a destination.
  if (!host || /[\s\x00-\x1f\x7f%\\/@?#*]/u.test(host)) return
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (isIP(bare) === 6) return new URL(`http://[${bare}]`).hostname.slice(1, -1)
  if (bare.includes(":")) return
  try {
    return new URL(`http://${bare}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** Same narrow host/port comparison in the worker; malformed entries deny. */
export function matchesRunSandboxDomain(
  request: RunSandboxNetworkRequest,
  domains: readonly string[]
): boolean {
  const host = canonicalHost(request.host)
  if (!host || !Number.isInteger(request.port) || request.port < 1 || request.port > 65535) return false
  return domains.some((entry) => {
    if (entry === "*") return true
    const parts = /^(\[[^\]]+\]|[^:]+?)(?::([1-9][0-9]{0,4}))?$/u.exec(entry)
    if (!parts || (parts[2] !== undefined &&
      (Number(parts[2]) > 65535 || Number(parts[2]) !== request.port))) return false
    const wildcard = parts[1].startsWith("*.")
    const pattern = canonicalHost(wildcard ? parts[1].slice(2) : parts[1])
    if (!pattern) return false
    if (!wildcard) return host === pattern
    return !isIP(host) && pattern.includes(".") && host.endsWith(`.${pattern}`)
  })
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

/**
 * Returns a real Node child synchronously for Claude's spawn hook. Codex may
 * consume the same object's CliChild interface. Initialization/wrapping happen
 * in the worker; any failure exits without ever launching an unwrapped CLI.
 */
export function spawnRunSandbox(options: RunSandboxLaunchOptions): RunSandboxChild {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("run sandbox launcher requires Linux or macOS process groups")
  }
  if (!options.command || options.command.includes("\0") || !isAbsolute(options.cwd)) {
    throw new Error("run sandbox requires a command and absolute cwd")
  }
  if (options.authToken !== undefined && (!options.authToken || Buffer.byteLength(options.authToken) > 1_048_576)) {
    throw new Error("invalid run sandbox auth pipe payload length")
  }
  // Clone before spawning or invoking user callbacks. Neither a caller's later
  // mutation nor a worker message can replace this run's authority or ceiling.
  const maximum = Object.freeze([...options.maxAllowDomains])
  const modelApiDomains = Object.freeze([...(options.modelApiDomains ?? [])])
  // Mikka's explicit unrestricted maximum is '*'; it is never installed as
  // a runtime allow (which would bypass live checks).
  NetworkConfigSchema.parse({ allowedDomains: maximum.filter((entry) => entry !== "*"), deniedDomains: [] })
  NetworkConfigSchema.parse({ allowedDomains: [...modelApiDomains], deniedDomains: [] })
  const onNetwork = options.onNetwork
  const abortSignal = options.signal
  const launch = {
    type: "init",
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: { ...options.env },
    policy: {
      allowWrite: [...options.policy.allowWrite],
      denyWrite: [...(options.policy.denyWrite ?? [])],
      denyRead: [...(options.policy.denyRead ?? [])],
    },
    maxAllowDomains: [...maximum],
    modelApiDomains: [...modelApiDomains],
    hasAuthToken: options.authToken !== undefined,
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("./run-sandbox-worker.mjs", import.meta.url))], {
    // Runtime helpers use the trusted daemon's environment. CLI env arrives
    // over IPC and is passed explicitly by the worker, without inheritance.
    env: process.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe", "ipc"],
    detached: true,
  }) as ChildProcessWithoutNullStreams
  const lifetime = new AbortController()
  const pending = new Map<number, { controller: AbortController; timer: NodeJS.Timeout }>()
  let stderr = ""
  let stopped = false
  let gone = false
  let outcome: { code: number | null; signal: string | null } | undefined
  let hardStop: NodeJS.Timeout | undefined
  let settle!: (exit: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { settle = resolve })

  function send(message: object) {
    if (!child.connected || gone) return
    child.send(message, (error) => { if (error) stop(0) })
  }

  function stop(graceMs = 3000) {
    if (gone) return
    if (!stopped) {
      stopped = true
      lifetime.abort()
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.controller.abort()
      }
      pending.clear()
      send({ type: "stop", graceMs })
    }
    // The worker normally resets the official runtime before exiting. A dead
    // or wedged worker must not keep its CLI, proxies or helpers alive.
    if (!hardStop) hardStop = setTimeout(() => {
      stderr += "\nrun sandbox worker did not stop; terminating its process group"
      try { signalGroup(child.pid, "SIGKILL") } catch (error) {
        stderr += `\nrun sandbox group termination failed: ${String(error)}`
      }
    }, Math.max(0, Math.min(graceMs, 30_000)) + 5000)
  }

  child.stderr.on("data", (data: Buffer | string) => {
    stderr = (stderr + data.toString()).slice(-16_000)
  })
  child.stdin.on("error", () => undefined)
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return
    const value = message as Record<string, unknown>
    if (value.type === "finished") {
      if ((value.code === null || Number.isInteger(value.code)) &&
        (value.signal === null || typeof value.signal === "string")) {
        outcome = { code: value.code as number | null, signal: value.signal as string | null }
      }
      return
    }
    if (value.type !== "network" || !Number.isSafeInteger(value.id) ||
      (value.id as number) < 1 || pending.has(value.id as number)) return
    const id = value.id as number
    const request: RunSandboxNetworkRequest = {
      host: typeof value.host === "string" ? value.host : "",
      port: typeof value.port === "number" ? value.port : 0,
    }
    if (typeof value.port !== "number" ||
      stopped || lifetime.signal.aborted || pending.size >= MAX_PENDING_NETWORK || !matchesRunSandboxDomain(request, maximum)) {
      send({ type: "decision", id, allow: false })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      controller.abort()
      send({ type: "decision", id, allow: false })
    }, NETWORK_DECISION_MS)
    pending.set(id, { controller, timer })
    // Capture this run in closure. No run id, command id or proxy username is
    // accepted from the sandboxed CLI as authority to select another callback.
    void Promise.resolve().then(() => {
      if (stopped || lifetime.signal.aborted) return false
      return onNetwork(request, controller.signal)
    }).then((allow) => {
      if (!pending.delete(id)) return
      clearTimeout(timer)
      send({ type: "decision", id, allow: allow === true && !stopped && !lifetime.signal.aborted && !controller.signal.aborted })
    }, () => {
      if (pending.delete(id)) {
        clearTimeout(timer)
        send({ type: "decision", id, allow: false })
      }
    })
  })

  function onParentExit() {
    try { signalGroup(child.pid, "SIGKILL") } catch { /* Cannot await during host exit. */ }
  }
  process.once("exit", onParentExit)
  function finish(code: number | null, signal: string | null) {
    if (gone) return
    gone = true
    stopped = true
    lifetime.abort()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.controller.abort()
    }
    pending.clear()
    clearTimeout(hardStop)
    abortSignal?.removeEventListener("abort", onAbort)
    process.removeListener("exit", onParentExit)
    // A descendant keeping the group alive after its leader exits must stop.
    try { signalGroup(child.pid, "SIGKILL") } catch (error) {
      stderr += `\nrun sandbox group cleanup failed: ${String(error)}`
    }
    settle(outcome ?? { code, signal })
  }
  child.once("error", (error) => {
    stderr += `\n${error.message}`
    stop(0)
    if (child.pid === undefined) finish(null, null)
  })
  child.once("exit", finish)
  child.once("disconnect", () => { if (!outcome) stop(0) })
  const authPipe = child.stdio[3] as Writable
  authPipe.on("error", () => stop(0))
  authPipe.end(options.authToken)
  function onAbort() { stop(0) }
  abortSignal?.addEventListener("abort", onAbort, { once: true })

  // SDK consumers call ChildProcess.kill directly, including SIGKILL. Route
  // that through revocation and runtime teardown; the bounded fallback above
  // is the only hard kill, and always addresses the entire process group.
  child.kill = (signal = "SIGTERM") => {
    if (gone) return false
    if (signal === 0) {
      try { process.kill(child.pid!, 0); return true } catch { return false }
    }
    stop(signal === "SIGKILL" ? 0 : 3000)
    return true
  }
  Object.defineProperty(child, "killed", { get: () => stopped })
  if (abortSignal?.aborted) stop(0)
  else send(launch)

  return {
    process: child,
    exited,
    stderrTail: () => stderr.slice(-4000).trim(),
    async kill(graceMs = 3000) { stop(graceMs); await exited },
    async revoke() { stop(0); await exited },
  }
}
