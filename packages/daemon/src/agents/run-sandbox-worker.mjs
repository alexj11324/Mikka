// This trusted host process owns exactly one SandboxManager and one CLI.
// Only its parent's private IPC channel can configure it or answer a request.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { isIP, Socket } from "node:net"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"

const AUTH_LIMIT = 1_048_576
const MAX_PENDING_NETWORK = 128
const NETWORK_DECISION_MS = 5 * 60_000

export function assertRunSandboxDependencies(dependencies, platform = process.platform) {
  if (dependencies.errors.length) {
    throw new Error(`sandbox dependencies unavailable: ${dependencies.errors.join("; ")}`)
  }
  // Official 0.0.80 reports a missing apply-seccomp helper as only a warning.
  // That would leave host Unix sockets reachable, so this launcher refuses to
  // initialize or wrap. Old/unknown Linux dependency warnings also fail closed.
  if (platform === "linux" && dependencies.warnings.length) {
    throw new Error(`sandbox isolation dependencies unsafe: ${dependencies.warnings.join("; ")}`)
  }
}

// Runs INSIDE the official sandbox. Linux bwrap deliberately closes extra
// inherited fds, so a framed stdin prefix carries the token across that
// boundary. It is converted to a token-only fd3 pipe before the real CLI starts.
async function authBridge() {
  let token
  let child
  let headerBytes = 0
  let tokenBytes = 0
  const header = Buffer.alloc(4)
  let complete = false
  const fail = () => {
    token?.fill(0)
    process.stderr.write("run sandbox auth pipe was incomplete or invalid\n")
    process.exit(1)
  }
  process.stdin.on("error", fail)
  process.stdin.once("end", () => { if (!complete) fail() })
  const read = (chunk) => {
    let offset = 0
    if (headerBytes < 4) {
      const count = Math.min(4 - headerBytes, chunk.length)
      chunk.copy(header, headerBytes, 0, count)
      headerBytes += count
      offset += count
      if (headerBytes === 4) {
        const length = header.readUInt32BE()
        if (length < 1 || length > AUTH_LIMIT) return fail()
        token = Buffer.alloc(length)
      }
    }
    if (token) {
      const count = Math.min(token.length - tokenBytes, chunk.length - offset)
      chunk.copy(token, tokenBytes, offset, offset + count)
      chunk.fill(0, offset, offset + count)
      tokenBytes += count
      offset += count
    }
    if (!token || tokenBytes !== token.length) return
    complete = true
    process.stdin.pause()
    process.stdin.off("data", read)
    if (offset < chunk.length) process.stdin.unshift(chunk.subarray(offset))
    child = spawn(process.argv[3], process.argv.slice(4), {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    })
    child.once("error", () => fail())
    child.stdin.on("error", () => undefined)
    child.stdio[3].on("error", fail)
    const payload = token
    child.stdio[3].end(payload, () => { payload.fill(0); token = undefined })
    // unshift above preserves protocol bytes delivered in the frame's last
    // chunk. pipe handles subsequent data and backpressure without parsing it.
    process.stdin.pipe(child.stdin)
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
    child.once("close", async (code, signal) => {
      token?.fill(0)
      await Promise.all([process.stdout, process.stderr].map((stream) =>
        new Promise((resolve) => stream.write("", resolve))))
      process.exit(code ?? (signal === "SIGINT" ? 130 : 143))
    })
  }
  process.stdin.on("data", read)
}

async function runWorker() {
const { NetworkConfigSchema, SandboxManager, SandboxRuntimeConfigSchema } = await import("@anthropic-ai/sandbox-runtime")

let configured = false
let active = false
let stopping = false
let cli
let initialize
let wrapping
let nextRequest = 0
let stderr = ""
let correlation
let initTimer
const pending = new Map()
const lifetime = new AbortController()

// Intentionally kept equivalent to the parent's exported matcher. Both sides
// independently apply the immutable maximum before a permission callback runs.
function canonicalHost(host) {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in a destination.
  if (!host || /[\s\x00-\x1f\x7f%\\/@?#*]/u.test(host)) return
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (isIP(bare) === 6) return new URL(`http://[${bare}]`).hostname.slice(1, -1)
  if (bare.includes(":")) return
  try { return new URL(`http://${bare}`).hostname.toLowerCase() } catch { return undefined }
}

function matchesDomain(request, domains) {
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
    return wildcard ? !isIP(host) && pattern.includes(".") && host.endsWith(`.${pattern}`) : host === pattern
  })
}

function quote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`
}

function send(message) {
  if (!process.connected) return
  process.send(message, (error) => { if (error) void stop(0) })
}

function denyPending() {
  active = false
  lifetime.abort()
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.resolve(false)
  }
  pending.clear()
}

function groupSignal(signal) {
  try { process.kill(-process.pid, signal) } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

async function stop(graceMs = 0, outcome = { code: null, signal: "SIGTERM" }) {
  denyPending()
  if (stopping) return
  stopping = true
  clearTimeout(initTimer)
  // The worker catches TERM; CLI descendants and runtime helpers share its
  // group. A final parent group kill also covers a descendant that ignores it.
  const watchdog = setTimeout(() => {
    process.stderr.write("run sandbox teardown timed out; terminating process group\n")
    groupSignal("SIGKILL")
  }, Math.max(0, Math.min(graceMs, 30_000)) + 4000)
  try {
    groupSignal("SIGTERM")
    if (cli && cli.exitCode === null && cli.signalCode === null) {
      // Linux bwrap creates a new session for its PID namespace. Address the
      // owned wrapper child directly as well as our group; --die-with-parent
      // and --unshare-pid end its nested workload when that wrapper dies.
      cli.kill(graceMs > 0 ? "SIGTERM" : "SIGKILL")
      await new Promise((resolve) => {
        const timer = setTimeout(() => { cli.kill("SIGKILL") }, Math.min(graceMs, 30_000))
        cli.once("exit", () => { clearTimeout(timer); resolve() })
      })
    }
    await initialize?.catch(() => undefined)
    await wrapping?.catch(() => undefined)
    // Official reset closes this launcher's established proxy connections and
    // removes only its own ephemeral sockets/mountpoints/CA/masked artifacts.
    // No worktree, run directory, logs or caller-owned data are removed here.
    await SandboxManager.reset()
    if (correlation) {
      const annotated = SandboxManager.annotateStderrWithSandboxFailures(correlation, stderr)
      if (annotated.length > stderr.length) process.stderr.write(annotated.slice(stderr.length))
    }
    if (process.connected) await new Promise((resolve) => {
      process.send({ type: "finished", ...outcome }, () => resolve())
    })
    // process.exit does not wait for writes; flush the bridged output first.
    await Promise.all([process.stdout, process.stderr].map((stream) =>
      new Promise((resolve) => stream.write("", resolve))))
    process.exit(outcome.code ?? (outcome.signal === "SIGINT" ? 130 : 143))
  } catch (error) {
    process.stderr.write(`run sandbox teardown failed: ${error.message}\n`)
    // A failed reset cannot be followed by a successful-looking exit or a
    // lingering live proxy. Group kill is fail-closed; parent also enforces it.
    groupSignal("SIGKILL")
  } finally {
    clearTimeout(watchdog)
  }
}

async function start(message) {
  try {
    if (typeof message.command !== "string" || !message.command || message.command.includes("\0") ||
      !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      typeof message.cwd !== "string" || !isAbsolute(message.cwd) ||
      !message.env || typeof message.env !== "object" || Array.isArray(message.env) ||
      Object.entries(message.env).some(([key, value]) => key.includes("=") || key.includes("\0") ||
        (value !== undefined && (typeof value !== "string" || value.includes("\0")))) ||
      !Array.isArray(message.maxAllowDomains) || !Array.isArray(message.modelApiDomains) ||
      typeof message.hasAuthToken !== "boolean") {
      throw new Error("invalid run sandbox launch configuration")
    }
    const maximum = Object.freeze([...message.maxAllowDomains])
    NetworkConfigSchema.parse({ allowedDomains: maximum.filter((entry) => entry !== "*"), deniedDomains: [] })
    NetworkConfigSchema.parse({ allowedDomains: [...message.modelApiDomains], deniedDomains: [] })
    const config = SandboxRuntimeConfigSchema.parse({
      // Every connection, even a model API connection, must consult the live
      // parent closure. No configured allow or command-id allow bypasses it.
      network: {
        allowedDomains: [], deniedDomains: [], strictAllowlist: false,
        allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [],
      },
      filesystem: message.policy,
      enableWeakerNetworkIsolation: true,
      enableWeakerNestedSandbox: false,
      allowNestedUserNamespaces: false,
    })
    if (!SandboxManager.isSupportedPlatform()) throw new Error("sandbox platform unsupported")
    const dependencies = SandboxManager.checkDependencies()
    assertRunSandboxDependencies(dependencies)
    if (stopping || !process.connected) return
    active = true
    initialize = SandboxManager.initialize(config, async (request) => {
      if (!active || stopping || !process.connected || pending.size >= MAX_PENDING_NETWORK || !matchesDomain(request, maximum)) return false
      const id = ++nextRequest
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve(false)
        }, NETWORK_DECISION_MS)
        pending.set(id, { resolve, timer })
        send({ type: "network", id, host: request.host, port: request.port })
      })
    })
    await initialize
    if (!active || stopping || !process.connected) return
    const argv = message.hasAuthToken
      ? [process.execPath, fileURLToPath(import.meta.url), "--auth-bridge", message.command, ...message.args]
      : [message.command, ...message.args]
    const command = argv.map(quote).join(" ")
    // Correlation is only for diagnostics, never network/run authority.
    correlation = randomUUID()
    wrapping = SandboxManager.wrapWithSandbox(command, "/bin/sh", undefined, lifetime.signal, { commandId: correlation })
    const wrapped = await wrapping
    if (!active || stopping || !process.connected) return
    const env = { ...message.env }
    // Node's private IPC setup must not be inherited by the untrusted CLI.
    delete env.NODE_CHANNEL_FD
    delete env.NODE_CHANNEL_SERIALIZATION_MODE
    if (message.hasAuthToken === true) {
      env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3"
      delete env.CLAUDE_CODE_OAUTH_TOKEN
    }
    cli = spawn("/bin/sh", ["-c", `exec ${wrapped}`], {
      cwd: message.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Stay in the launcher's group, so even an abrupt worker failure cannot
      // orphan an independently detached CLI before its pid can be reported.
      detached: false,
    })
    cli.stdin.on("error", () => undefined)
    if (message.hasAuthToken) {
      // The token arrives on a separate host pipe. Frame it before forwarding
      // any protocol input, so neither packet boundaries nor early SDK writes
      // can mix credentials with the first CLI message.
      const source = new Socket({ fd: 3, readable: true, writable: false })
      const chunks = []
      let length = 0
      source.on("data", (data) => {
        length += data.length
        if (length > AUTH_LIMIT) {
          data.fill(0)
          source.destroy(new Error("auth pipe payload too large"))
        } else chunks.push(data)
      })
      source.once("error", () => {
        for (const chunk of chunks) chunk.fill(0)
        process.stderr.write("run sandbox auth pipe failed\n")
        void stop(0, { code: 1, signal: null })
      })
      source.once("end", () => {
        if (!length || stopping) {
          for (const chunk of chunks) chunk.fill(0)
          void stop(0, { code: 1, signal: null })
          return
        }
        const payload = Buffer.concat(chunks)
        for (const chunk of chunks) chunk.fill(0)
        const header = Buffer.alloc(4)
        header.writeUInt32BE(payload.length)
        cli.stdin.write(header)
        cli.stdin.write(payload, () => payload.fill(0))
        process.stdin.pipe(cli.stdin)
      })
    } else process.stdin.pipe(cli.stdin)
    cli.stdout.pipe(process.stdout, { end: false })
    cli.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-16_000) })
    cli.stderr.pipe(process.stderr, { end: false })
    cli.once("error", (error) => {
      process.stderr.write(`sandboxed CLI launch failed: ${error.message}\n`)
      void stop(0, { code: 1, signal: null })
    })
    cli.once("close", (code, signal) => { void stop(0, { code, signal }) })
  } catch (error) {
    process.stderr.write(`run sandbox launch failed: ${error.message}\n`)
    await stop(0, { code: 1, signal: null })
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return
  if (message.type === "stop") {
    void stop(Number.isFinite(message.graceMs) ? Math.max(0, message.graceMs) : 0)
  } else if (message.type === "init" && !configured && !stopping) {
    configured = true
    clearTimeout(initTimer)
    void start(message)
  } else if (message.type === "decision" && Number.isSafeInteger(message.id)) {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    request.resolve(message.allow === true && active && !stopping && process.connected)
  }
})
process.on("disconnect", () => { void stop(0) })
process.on("SIGTERM", () => { void stop(0) })
process.on("SIGINT", () => { void stop(0, { code: null, signal: "SIGINT" }) })
process.stdout.on("error", () => { void stop(0) })
process.stderr.on("error", () => { void stop(0) })
initTimer = setTimeout(() => {
  process.stderr.write("run sandbox launch configuration was not received\n")
  void stop(0, { code: 1, signal: null })
}, 10_000)
if (!process.connected) void stop(0, { code: 1, signal: null })
}

// Importing the pure dependency check for source-only tests does not start a
// launcher, touch resources or initialize the official manager.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--auth-bridge") await authBridge()
  else await runWorker()
}
