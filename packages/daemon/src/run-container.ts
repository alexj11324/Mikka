// Docker mode (devices are runners, 2026-10-31): on a Linux device with a
// Docker engine, each Claude Code or Codex run is a disposable container
// (`--rm`) of the runner image (harness/Dockerfile, the daemon's pinned
// harnesses). It sees only what the run may write (its worktree, git paths
// and run dir) plus the Mikka MCP helper, read-only. It has no network
// interface: its traffic goes through one mounted socket where the daemon
// applies the run's network approval, as the hosted runner does. Credentials
// reach it as environment values passed by name, never in the argument list.
// Without Docker (most Macs), runs keep the per-run home and official sandbox.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { execa } from "execa"

import type { CliChild } from "./agents/child"
import { MCP_SERVER_SCRIPT } from "./agents/run-context"
import { startPublicEgress } from "./agents/public-egress"
import type { SandboxPolicy } from "./agents/sandbox"

export type RunIsolation = "container" | "worktree"
export const RUN_CONTAINER_LABEL = "com.mikka.run"
const IMAGE_REPOSITORY = "mikka-runner"
const ENTRY = fileURLToPath(new URL("./agents/run-container-entry.mjs", import.meta.url))
const EGRESS_RELAY = fileURLToPath(new URL("./agents/native-egress.mjs", import.meta.url))
const IMAGE_SOURCES = ["harness/Dockerfile", "harness/pins.json", "harness/install.mjs", "harness/cli.mjs"]

/**
 * Container mode needs Linux (the egress socket is bind-mounted into the
 * container, which Docker Desktop's VM does not pass through) and a Docker
 * engine. A run with a local computer still uses the worktree mode (its
 * broker listens on the host's loopback); the adapters check that per run.
 */
export function selectIsolation(platform: NodeJS.Platform, docker: boolean): RunIsolation {
  return platform === "linux" && docker ? "container" : "worktree"
}

/** packages/daemon in the source tree, the package root in the npm build. */
function imageContext(): string {
  for (const candidate of [new URL("../", import.meta.url), new URL("./", import.meta.url)]) {
    const dir = fileURLToPath(candidate)
    if (existsSync(join(dir, "harness", "Dockerfile"))) return dir
  }
  throw new Error("runner image sources unavailable")
}

/** The tag is the hash of everything the image is built from. */
export function runnerImageTag(context: string = imageContext()): string {
  const hash = createHash("sha256")
  for (const file of IMAGE_SOURCES) hash.update(file).update("\0").update(readFileSync(join(context, file))).update("\0")
  return `${IMAGE_REPOSITORY}:${hash.digest("hex").slice(0, 16)}`
}

let building: Promise<string> | undefined
/** Built locally from the shipped Dockerfile on first need; reused after. */
export function ensureRunnerImage(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  building ??= (async () => {
    const context = imageContext()
    const tag = runnerImageTag(context)
    const dockerEnv = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}) }
    const present = await execa("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { env: dockerEnv, extendEnv: false, reject: false })
    if (present.exitCode !== 0) {
      await execa("docker", ["build", "-q", "-t", tag, "-f", join(context, "harness", "Dockerfile"), context], { env: { ...dockerEnv, DOCKER_BUILDKIT: "1" }, extendEnv: false, timeout: 900_000 })
    }
    return tag
  })().catch(error => { building = undefined; throw error })
  return building
}

export interface RunContainerOptions {
  image: string
  runId: string
  /** Hash of the daemon's data dir: which daemon owns the container. */
  owner: string
  cwd: string
  policy: SandboxPolicy
  /** The run's live network decision (agents/run-network.ts). */
  onNetwork(request: { host: string; port: number }, signal: AbortSignal): Promise<boolean>
  signal?: AbortSignal
}

export function containerOwner(dataDir: string) {
  return createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 16)
}

/** Read-write for what the run may write, read-only over what it must not change. */
export function containerMounts(policy: SandboxPolicy, gitCommonDir: string | null): string[] {
  const mounts = new Map<string, "ro" | "rw">()
  if (gitCommonDir) mounts.set(gitCommonDir, "ro")
  for (const path of policy.allowWrite) mounts.set(path, "rw")
  for (const path of policy.denyWrite ?? []) if (existsSync(path)) mounts.set(path, "ro")
  for (const path of [MCP_SERVER_SCRIPT, join(dirname(MCP_SERVER_SCRIPT), "capture-copy.mjs")]) mounts.set(path, "ro")
  return [...mounts].flatMap(([path, mode]) => ["-v", `${path}:${path}:${mode}`])
}

/** `docker run` arguments: values of `env` never appear here, only names. */
export function containerArgs(options: {
  image: string; runId: string; owner: string; name: string; cwd: string; command: string; args: readonly string[]
  env: Record<string, string | undefined>; mounts: string[]; egressSocket?: string; uid: number; gid: number
}): string[] {
  return [
    "run", "--rm", "-i", "--init", "--pull=never",
    "--name", options.name, "--label", `${RUN_CONTAINER_LABEL}=${options.owner}`, "--label", `${RUN_CONTAINER_LABEL}.run=${options.runId}`,
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", `${options.uid}:${options.gid}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    ...options.mounts,
    "-v", `${ENTRY}:/mikka/run-container-entry.mjs:ro`,
    "-v", `${EGRESS_RELAY}:/mikka/native-egress.mjs:ro`,
    ...(options.egressSocket ? ["-v", `${options.egressSocket}:/run/mikka-egress.sock`] : []),
    ...Object.keys(options.env).filter(name => options.env[name] !== undefined && name !== "PATH").flatMap(name => ["-e", name]),
    "-w", options.cwd,
    options.image,
    "node", "/mikka/run-container-entry.mjs", options.command, ...options.args,
  ]
}

function gitCommonDir(worktree: string): string | null {
  try {
    const pointer = readFileSync(join(worktree, ".git"), "utf8").match(/^gitdir: (.+)$/m)?.[1]
    if (!pointer) return null
    const gitDir = resolve(worktree, pointer.trim())
    return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
  } catch {
    return null
  }
}

export interface RunContainerChild extends CliChild {
  revoke(): Promise<void>
}

export interface RunContainer {
  /** Starts one CLI process in a fresh container; synchronous, for Claude's spawn hook. */
  spawn(command: string, args: readonly string[], env: Record<string, string | undefined>): RunContainerChild
  close(): Promise<void>
}

function dockerEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) }
}

/** The run's egress socket, opened once; each spawn is one disposable container. */
export async function openRunContainer(options: RunContainerOptions): Promise<RunContainer> {
  const lifetime = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
  const egress = await startPublicEgress({ signal, authorize: (destination, abort) => options.onNetwork(destination, abort) })
  const mounts = containerMounts(options.policy, gitCommonDir(options.cwd))
  const children = new Set<RunContainerChild>()
  let count = 0
  return {
    spawn(command, args, env) {
      const name = `mikka-run-${options.runId}-${++count}-${Date.now().toString(36)}`
      const argv = containerArgs({ ...options, name, command, args, env, mounts, egressSocket: egress.socketPath, uid: process.getuid!(), gid: process.getgid!() })
      const childEnv = dockerEnv()
      for (const [key, value] of Object.entries(env)) if (value !== undefined && key !== "PATH") childEnv[key] = value
      const child = spawn("docker", argv, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams
      let stderr = ""
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
      const exited = new Promise<{ code: number | null; signal: string | null }>(done => {
        child.once("error", () => done({ code: 127, signal: null }))
        child.once("exit", (code, exitSignal) => done({ code, signal: exitSignal }))
      })
      const remove = async () => {
        await execa("docker", ["rm", "-f", name], { env: dockerEnv(), extendEnv: false, reject: false, timeout: 30_000 })
        await exited
      }
      const handle: RunContainerChild = { process: child, exited, stderrTail: () => stderr.trim(), kill: remove, revoke: remove }
      children.add(handle)
      void exited.then(() => children.delete(handle))
      return handle
    },
    async close() {
      lifetime.abort()
      await Promise.all([...children].map(child => child.kill()))
      await egress.close().catch(() => undefined)
    },
  }
}

/** Containers a killed daemon left running: removed at daemon start. */
export async function sweepRunContainers(owner: string) {
  const env = dockerEnv()
  const listed = await execa("docker", ["ps", "-aq", "--filter", `label=${RUN_CONTAINER_LABEL}=${owner}`], { env, extendEnv: false, reject: false, timeout: 30_000 })
  const ids = String(listed.stdout ?? "").split("\n").filter(id => /^[a-f0-9]{12,64}$/.test(id))
  if (ids.length) await execa("docker", ["rm", "-f", ...ids], { env, extendEnv: false, reject: false, timeout: 30_000 })
}
